#!/usr/bin/env bash
# The agent in the container and the memory of what it did: Claude Code in
# every base image, the $HOME bind, the lent environment, and the handoff note
# `down` writes before the container that knows anything is gone.
#
#   bash test/agent-done-check.sh
#   BARDOLIER_SKIP_DOCKER=1 …    offline assertions only
#   VERBOSE=1 …                  print every passing line
set -uo pipefail

source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
sandbox

APP="app/bardolier/bardolier"
VOLUME="$TMP/ssd"
track bardolier-myapp
track_volume bardolier-myapp-home

# The Docker half is the point here; the offline half still says what it can.
docker_ready || true

# ── 1. the images ────────────────────────────────────────────────────────────

head "1. Claude Code is in every base image"

for image in bardolier-web bardolier-ios bardolier-and; do
  DF="cli/images/$image/Dockerfile"
  if grep -q 'ARG CLAUDE_CODE_VERSION=' "$DF" && grep -q 'sha256sum -c -' "$DF"; then
    ok "$image pins and verifies the agent"
  else
    bad "$image must pin a version and verify the download"
  fi
  if grep -q -- '-o /usr/local/bin/claude' "$DF"; then
    ok "$image installs it outside \$HOME (which is a mounted volume)"
  else
    bad "$image installs the agent where the home volume would hide or duplicate it"
  fi
done

# The one constant four things must agree about: images.ts, three Dockerfiles.
HOME_PATH="$(node --input-type=module -e "
  import { CONTAINER_HOME } from './cli/src/images.ts'
  process.stdout.write(CONTAINER_HOME)
")"
for image in bardolier-web bardolier-ios bardolier-and; do
  if grep -q "ENV HOME=$HOME_PATH" "cli/images/$image/Dockerfile"; then
    ok "$image sets \$HOME to $HOME_PATH"
  else
    bad "$image disagrees with images.ts about \$HOME — the login would be lost on every down"
  fi
done

if [ "$DOCKER_OK" = "1" ]; then
  for image in bardolier-web bardolier-ios bardolier-and; do
    if ! docker image inspect "$image:latest" >/dev/null 2>&1; then
      skip "$image:latest is not built — \`bardolier build\` to check it for real"
      continue
    fi
    # A scalar, not an array: `set -u` treats an empty array expansion as an
    # unbound variable, and an empty scalar simply word-splits to nothing.
    PLATFORM=""
    [ "$image" = "bardolier-and" ] && PLATFORM="--platform=linux/amd64"
    # shellcheck disable=SC2086
    OUT="$(docker run --rm $PLATFORM "$image:latest" \
      sh -c 'printf "%s %s " "$(claude --version 2>/dev/null | head -1)" "$HOME"; command -v git >/dev/null && printf git' 2>/dev/null || true)"
    case "$OUT" in
      *"(Claude Code)"*"$HOME_PATH"*git*) ok "$image runs the agent, at \$HOME=$HOME_PATH, with git" ;;
      *) bad "$image did not answer as expected: ${OUT:-<nothing>}" ;;
    esac
  done
else
  skip "built-image checks (no daemon, or BARDOLIER_SKIP_DOCKER=1)"
fi

# ── 2. what the generated file says ──────────────────────────────────────────

head "2. Compose generation (§9)"

$BARDOLIER new p9web --archetype web --json >"$TMP/new.json"
COMPOSE="$MOUNTED/p9web/docker-compose.yml"

grep -q -- "- ./home:$HOME_PATH" "$COMPOSE" \
  && ok "the dev container's \$HOME is the project's own home/ folder (phase 19)" \
  || bad "no home bind in the generated file"

grep -q 'bardolier.role: home' "$COMPOSE" \
  && bad "the home is still a labelled named volume" \
  || ok "it needs no label: being inside the project directory is the attribution"

# The point of Compose's bare list form: names, never values.
if grep -qE '^ *- CLAUDE_CODE_OAUTH_TOKEN$' "$COMPOSE" && ! grep -q 'CLAUDE_CODE_OAUTH_TOKEN=' "$COMPOSE"; then
  ok "host variables are passed by NAME — an absent token stays absent, not empty"
else
  bad "the environment block should name variables without giving them values"
fi

grep -q '\${' "$COMPOSE" \
  && bad "no \${...} interpolation belongs in the generated file" \
  || ok "no interpolation — the same manifest renders the same bytes anywhere"

APP_PORT="$(node -e "
  const { parse } = require('yaml')
  const d = parse(require('fs').readFileSync('$MOUNTED/p9web/project.yml','utf8'))
  process.stdout.write(String(d.app_port ?? ''))
")"
[ -n "$APP_PORT" ] \
  && ok "a web project is assigned a dev-server port ($APP_PORT) at creation" \
  || bad "no app_port in the manifest"

grep -q "\- ${APP_PORT}:3000" "$COMPOSE" \
  && ok "and publishes it, fixed inside and variable outside" \
  || bad "the dev-server port is not published"

grep -qE '^ *- PORT=3000$' "$COMPOSE" \
  && ok "PORT tells the server which port to bind" \
  || bad "PORT is not set in the container"

$BARDOLIER new p9ios --archetype ios --json >/dev/null
grep -q 'ports:' "$MOUNTED/p9ios/docker-compose.yml" \
  && bad "an ios project must publish nothing" \
  || ok "an archetype that serves nothing publishes nothing"

# The retrofit path: every project that existed before the field.
$BARDOLIER new p9old --archetype web --json >/dev/null
node -e "
  const fs = require('fs')
  const p = '$MOUNTED/p9old/project.yml'
  fs.writeFileSync(p, fs.readFileSync(p,'utf8').split('\n').filter(l => !l.startsWith('app_port:')).join('\n'))
"
grep -q '^app_port:' "$MOUNTED/p9old/project.yml" \
  && bad "could not simulate a project that predates the field" \
  || ok "simulated a project with no app_port"

# ── 3. the lifecycle, for real ───────────────────────────────────────────────

head "3. \$HOME survives the stop, and the handoff records it (§12)"

if [ "$DOCKER_OK" = "1" ] && docker image inspect bardolier-web:latest >/dev/null 2>&1; then
  $BARDOLIER up p9old --no-shell --json >"$TMP/up-old.json"
  json_assert "$(cat "$TMP/up-old.json")" "d.app_port !== null && d.app_url.startsWith('http://localhost:')" \
    && ok "a project that predates the field is assigned one on its next up" \
    || bad "up did not retrofit the dev-server port"
  grep -q '^app_port:' "$MOUNTED/p9old/project.yml" \
    && ok "and persists it, because a port is decided once (§5)" \
    || bad "the retrofitted port was not written to the manifest"

  $BARDOLIER up p9web --no-shell --json >/dev/null
  docker exec bardolier-p9web sh -c 'echo written-before-the-stop > $HOME/.p9-marker' >/dev/null 2>&1 \
    && ok "wrote a marker into the container's \$HOME" \
    || bad "could not write to \$HOME in the container"

  # A repository under work/ for the handoff's other half to describe (§3).
  ( cd "$MOUNTED/p9web/work" \
    && git init -q \
    && git -c user.name=T -c user.email=t@e add -A \
    && git -c user.name=T -c user.email=t@e commit -qm "Phase 9 done-check" \
    && echo scratch > uncommitted.txt ) >/dev/null 2>&1

  $BARDOLIER down p9web --json >"$TMP/down.json"
  json_assert "$(cat "$TMP/down.json")" "d.state === 'stopped'" \
    && ok "down succeeded" || bad "down failed"

  NOTE="$MOUNTED/p9web/.bardolier/handoff.md"
  [ -f "$NOTE" ] && ok "the handoff note was written" || bad "no handoff note at $NOTE"
  grep -q 'Phase 9 done-check' "$NOTE" \
    && ok "it carries the repository's recent commits" \
    || bad "the note does not mention the commit"
  grep -q 'uncommitted.txt' "$NOTE" \
    && ok "and what was still uncommitted" \
    || bad "the note does not mention the uncommitted file"
  # Unauthenticated in a done-check, so this is the DEGRADED path — and it must
  # degrade to a sentence, never to a pasted refusal.
  grep -q 'Not logged in' "$NOTE" \
    && bad "a refusal from the agent was pasted in as if it were a summary" \
    || ok "an agent that cannot answer costs the note its summary, not the stop"

  $BARDOLIER up p9web --no-shell --json >/dev/null
  MARKER="$(docker exec bardolier-p9web sh -c 'cat $HOME/.p9-marker' 2>/dev/null || true)"
  [ "$MARKER" = "written-before-the-stop" ] \
    && ok "\$HOME survived a full down/up — the container was removed, the volume was not" \
    || bad "\$HOME did not survive the stop (got: ${MARKER:-<nothing>})"

  $BARDOLIER down p9web --no-handoff --json >"$TMP/down2.json"
  json_assert "$(cat "$TMP/down2.json")" "d.handoff_path === null" \
    && ok "--no-handoff writes nothing" || bad "--no-handoff still wrote a note"

  $BARDOLIER down p9old --no-handoff --json >/dev/null 2>&1 || true
else
  skip "the live lifecycle (needs a daemon and bardolier-web:latest — \`bardolier build\`)"
fi

# ── 4. the app ───────────────────────────────────────────────────────────────

head "4. The menu says why an item is inert (§11)"

grep -q 'disabledReason' "$APP/Views/MenuChrome.swift" \
  && ok "MenuRow carries a reason" \
  || bad "MenuRow still has no way to explain a disabled item"

grep -q 'struct DisabledNotice' "$APP/Views/MenuChrome.swift" \
  && ok "and there is one notice per group rather than one per row" \
  || bad "no DisabledNotice"

grep -q 'mutationBlockedReason' "$APP/Views/MenuBarRootView.swift" \
  && ok "the menu computes it beside the rule it explains" \
  || bad "MenuBarRootView does not compute a reason"

grep -q 'appUrl' "$APP/Bardolier/BardolierModels.swift" \
  && ok "the app reads the dev-server URL rather than composing one" \
  || bad "BardolierProject does not decode app_url"

SDK="$(xcrun --show-sdk-path 2>/dev/null || true)"
if command -v swiftc >/dev/null 2>&1 && [ -n "$SDK" ]; then
  if swiftc -typecheck -swift-version 5 -default-isolation MainActor -strict-concurrency=complete \
      -enable-upcoming-feature MemberImportVisibility \
      -enable-upcoming-feature DisableOutwardActorInference \
      -enable-upcoming-feature GlobalActorIsolatedTypesUsability \
      -enable-upcoming-feature InferSendableFromCaptures \
      -enable-upcoming-feature NonisolatedNonsendingByDefault \
      -target arm64-apple-macos15.0 -sdk "$SDK" $(find "$APP" -name '*.swift') >"$TMP/swift.log" 2>&1; then
    ok "the app sources type-check (weaker than ⌘B: catches nothing about Xcode target membership)"
  else
    bad "swiftc -typecheck failed:"
    grep "error:" "$TMP/swift.log" | head -5 | sed 's/^/      /'
  fi
else
  skip "the Swift type-check (no toolchain)"
fi

# ── Summary ───────────────────────────────────────────────────────────────────
summary "Agent"
