#!/usr/bin/env bash
# Phase 2 done-check — new → up → /work mounted and owned by the host user →
# down (container gone, data kept) → delete, with `status` tracking each step.
# The SSD is a temp dir (BARDOLIER_SSD_ROOT, §8); the Docker half is real and builds
# the base image if it is missing.
#
#   bash test/phase2-done-check.sh
#   BARDOLIER_SKIP_DOCKER=1 …    offline assertions only
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO"

BARDOLIER="node cli/bin/bardolier.js"
pass=0
fail=0

ok()   { pass=$((pass + 1)); if [ -n "${VERBOSE:-}" ]; then printf '  \033[32m✓\033[0m %s\n' "$1"; fi; }
bad()  { printf '  \033[31m✗\033[0m %s\n' "$1"; fail=$((fail + 1)); }
skip() { printf '  \033[33m–\033[0m %s\n' "$1"; }
head() { printf '\n\033[1m%s\033[0m\n' "$1"; }

TMP="$(mktemp -d)"
cleanup() {
  # Never leave containers behind, whatever went wrong above.
  if [ "${DOCKER_OK:-0}" = "1" ]; then
    docker rm -f bardolier-myapp bardolier-second >/dev/null 2>&1 || true
    # Every project now owns a $HOME volume (cli-spec.md §9); a check that left
    # them behind would litter the machine with one per run.
    docker volume rm -f bardolier-myapp-home bardolier-second-home >/dev/null 2>&1 || true
  fi
  rm -rf "$TMP"
}
trap cleanup EXIT

MOUNTED="$TMP/ssd/claude-projects"
ABSENT="$TMP/nowhere/claude-projects"
mkdir -p "$MOUNTED"

export BARDOLIER_CONFIG="$TMP/config.yml"
export BARDOLIER_SSD_VOLUME="$TMP/ssd"
export BARDOLIER_SSD_ROOT="$MOUNTED"

json_assert() { # json_assert <json> <js body over `d`>
  node -e "
    const d = JSON.parse(process.argv[1])
    process.exit((${2}) ? 0 : 1)
  " "$1" 2>/dev/null
}

schema_assert() { # schema_assert <schema-name> <json>
  node --input-type=module -e "
    import { validate } from './cli/src/schema.ts'
    const { valid, errors } = validate(process.argv[1], JSON.parse(process.argv[2]))
    if (!valid) { console.error(errors.join('\n')); process.exit(1) }
  " "$1" "$2" 2>/dev/null
}

# ── 1. new ────────────────────────────────────────────────────────────────────
head "1. \`new\` creates the project (§6, §10)"

NEW="$($BARDOLIER new myapp --archetype web --json)" || bad "new exited non-zero"
schema_assert new "$NEW" && ok "new --json validates against new.schema.json" || bad "new output does not match its schema"

for file in project.yml docker-compose.yml .gitignore .dockerignore CLAUDE.md; do
  [ -f "$MOUNTED/myapp/$file" ] && ok "seeded $file" || bad "MISSING: $file"
done

node --input-type=module -e "
  import { readFileSync } from 'node:fs'
  import { parse } from 'yaml'
  import { validate } from './cli/src/schema.ts'
  const m = parse(readFileSync(process.argv[1], 'utf8'))
  const { valid, errors } = validate('project', m)
  if (!valid) { console.error(errors.join('\n')); process.exit(1) }
  if (m.name !== 'myapp' || m.archetype !== 'web' || m.base_image !== 'bardolier-web') process.exit(1)
" "$MOUNTED/myapp/project.yml" 2>/dev/null \
  && ok "project.yml validates and records archetype → base image (§4.2, §4.3)" \
  || bad "project.yml is wrong"

grep -q 'DO NOT EDIT' "$MOUNTED/myapp/docker-compose.yml" \
  && ok "the compose file says it is generated (§9)" || bad "compose file has no generated-file warning"
grep -q 'xcodebuild\|in the container' "$MOUNTED/myapp/CLAUDE.md" \
  && ok "seeded CLAUDE.md carries the archetype boundary note (§10)" || bad "CLAUDE.md has no boundary note"
grep -q 'postgres:5432' "$MOUNTED/myapp/CLAUDE.md" \
  && ok "seeded CLAUDE.md points at the Docker network, not localhost (§5)" || bad "CLAUDE.md does not steer away from localhost"

# Error paths.
EXISTS="$($BARDOLIER new myapp --archetype web --json 2>/dev/null || true)"
json_assert "$EXISTS" 'd.error && d.error.code === "PROJECT_EXISTS"' \
  && ok "a second new is PROJECT_EXISTS" || bad "duplicate new did not fail PROJECT_EXISTS"

UNMOUNTED="$(BARDOLIER_SSD_ROOT="$ABSENT" $BARDOLIER new nope --archetype web --json 2>/dev/null || true)"
json_assert "$UNMOUNTED" 'd.error && d.error.code === "SSD_NOT_MOUNTED"' \
  && ok "new with the SSD absent is SSD_NOT_MOUNTED" || bad "new did not fail SSD_NOT_MOUNTED"
[ ! -e "$ABSENT" ] && ok "no project directory was created on the internal disk" || bad "new created $ABSENT"

BADTYPE="$($BARDOLIER new other --archetype toaster --json 2>/dev/null || true)"
json_assert "$BADTYPE" 'd.error && d.error.code === "INVALID_ARGUMENT"' \
  && ok "an unknown archetype is refused" || bad "an unknown archetype was accepted"

# ── 2. Compose generation is deterministic (§9) ───────────────────────────────
head "2. Compose generation is deterministic (§9)"

BEFORE="$(shasum "$MOUNTED/myapp/docker-compose.yml" | cut -d' ' -f1)"
node --input-type=module -e "
  import { readFileSync } from 'node:fs'
  import { parse } from 'yaml'
  import { regenerateCompose } from './cli/src/workspace.ts'
  const dir = process.argv[1]
  const manifest = parse(readFileSync(dir + '/project.yml', 'utf8'))
  const first = regenerateCompose(dir, manifest, null)
  const second = regenerateCompose(dir, manifest, null)
  if (first.changed || second.changed) { console.error('regeneration was not a no-op'); process.exit(1) }
" "$MOUNTED/myapp" 2>/dev/null \
  && ok "regenerating an unchanged manifest is a no-op" || bad "regeneration reported a spurious change"

AFTER="$(shasum "$MOUNTED/myapp/docker-compose.yml" | cut -d' ' -f1)"
[ "$BEFORE" = "$AFTER" ] && ok "the bytes are identical across regenerations" || bad "the compose file changed on regeneration"

grep -q '\.:/work' "$MOUNTED/myapp/docker-compose.yml" \
  && ok "the dev container bind-mounts the project dir at /work" || bad "no /work bind mount"
grep -q "$TMP" "$MOUNTED/myapp/docker-compose.yml" \
  && bad "the compose file hard-codes the SSD path" || ok "no absolute SSD path leaks into the compose file"

# A hand-edited compose file must lose to project.yml.
echo '# vandalised' >> "$MOUNTED/myapp/docker-compose.yml"
node --input-type=module -e "
  import { readFileSync } from 'node:fs'
  import { parse } from 'yaml'
  import { regenerateCompose } from './cli/src/workspace.ts'
  const dir = process.argv[1]
  regenerateCompose(dir, parse(readFileSync(dir + '/project.yml', 'utf8')), null)
" "$MOUNTED/myapp"
grep -q 'vandalised' "$MOUNTED/myapp/docker-compose.yml" \
  && bad "a hand edit survived regeneration" || ok "a hand-edited compose file is overwritten (project.yml is the truth)"

# ── 3. status reflects a stopped, freshly-created project ─────────────────────
head "3. \`status\` sees the new project"

STATUS="$($BARDOLIER status myapp --json)"
schema_assert status "$STATUS" && ok "status still matches the §7 schema" || bad "status output broke its schema"
json_assert "$STATUS" 'd.projects[0].name === "myapp" && d.projects[0].state === "stopped" && d.projects[0].dev_container === null' \
  && ok "reports the project stopped with no dev container" || bad "status is wrong for a new project"

# ── 4. The Docker half: build → up → exec → down ──────────────────────────────
head "4. Lifecycle against a real daemon"

DOCKER_OK=0
if [ "${BARDOLIER_SKIP_DOCKER:-0}" = "1" ]; then
  skip "BARDOLIER_SKIP_DOCKER=1 — skipping the Docker lifecycle"
elif ! docker version --format '{{.Server.Version}}' >/dev/null 2>&1; then
  skip "no Docker daemon — skipping the lifecycle (the offline checks above still ran)"
else
  DOCKER_OK=1
fi

if [ "$DOCKER_OK" = "1" ]; then
  docker rm -f bardolier-myapp >/dev/null 2>&1 || true
  docker volume rm -f bardolier-myapp-home bardolier-second-home >/dev/null 2>&1 || true

  if ! docker image inspect bardolier-web:latest >/dev/null 2>&1; then
    printf '    building bardolier-web (first run only, this takes a few minutes)…\n'
    if $BARDOLIER build --archetype web >/dev/null 2>&1; then
      ok "bardolier build produced bardolier-web:latest"
    else
      bad "bardolier build failed"
    fi
  else
    ok "bardolier-web:latest is present (built by \`bardolier build\`)"
  fi

  BUILD="$($BARDOLIER build --archetype web --json)"
  schema_assert build "$BUILD" && ok "build --json validates against build.schema.json" || bad "build output does not match its schema"
  json_assert "$BUILD" "d.uid === $(id -u) && d.gid === $(id -g)" \
    && ok "build passes the host UID/GID as build args" || bad "build did not report the host UID/GID"

  UP="$($BARDOLIER up myapp --json)" || bad "up exited non-zero"
  schema_assert up "$UP" && ok "up --json validates against up.schema.json" || bad "up output does not match its schema"
  json_assert "$UP" 'd.state === "running" && d.already_running === false && d.dev_container === "bardolier-myapp"' \
    && ok "up started the project" || bad "up did not report a running project"

  json_assert "$($BARDOLIER status myapp --json)" 'd.projects[0].state === "running" && d.projects[0].dev_container === "bardolier-myapp"' \
    && ok "status reflects the transition to running" || bad "status did not follow up"

  # The done-check's own words: /work mounted, owned by your user.
  if docker exec bardolier-myapp test -d /work; then
    ok "docker exec shows /work mounted"
  else
    bad "/work is not mounted in the dev container"
  fi

  CONTAINER_UID="$(docker exec bardolier-myapp stat -c '%u' /work 2>/dev/null || echo 'x')"
  CONTAINER_GID="$(docker exec bardolier-myapp stat -c '%g' /work 2>/dev/null || echo 'x')"
  [ "$CONTAINER_UID" = "$(id -u)" ] && [ "$CONTAINER_GID" = "$(id -g)" ] \
    && ok "/work is owned by $(id -u):$(id -g) — your user, not root" \
    || bad "/work is owned by $CONTAINER_UID:$CONTAINER_GID, expected $(id -u):$(id -g)"

  docker exec bardolier-myapp sh -c 'echo hello > /work/from-container.txt' 2>/dev/null || true
  if [ -f "$MOUNTED/myapp/from-container.txt" ]; then
    OWNER="$(stat -f '%u' "$MOUNTED/myapp/from-container.txt" 2>/dev/null || stat -c '%u' "$MOUNTED/myapp/from-container.txt")"
    [ "$OWNER" = "$(id -u)" ] \
      && ok "a file written in the container lands on the host owned by you" \
      || bad "container-written file is owned by $OWNER on the host"
  else
    bad "a file written in the container did not appear on the host"
  fi

  json_assert "$($BARDOLIER up myapp --json)" 'd.already_running === true && d.compose_regenerated === false' \
    && ok "up on a running project is an idempotent no-op (§2)" || bad "a second up was not a no-op"

  DOWN="$($BARDOLIER down myapp --json)" || bad "down exited non-zero"
  schema_assert down "$DOWN" && ok "down --json validates against down.schema.json" || bad "down output does not match its schema"
  json_assert "$DOWN" 'd.was_running === true && d.state === "stopped" && d.data_kept === true' \
    && ok "down stopped the project and kept its data" || bad "down reported the wrong outcome"

  [ -z "$(docker ps -a --filter name='^bardolier-myapp$' --format '{{.Names}}')" ] \
    && ok "down removed the container" || bad "the container survived down"

  [ -f "$MOUNTED/myapp/from-container.txt" ] && [ -f "$MOUNTED/myapp/project.yml" ] \
    && ok "data persists across down" || bad "down destroyed project data"

  json_assert "$($BARDOLIER status myapp --json)" 'd.projects[0].state === "stopped" && d.projects[0].dev_container === null' \
    && ok "status reflects the transition back to stopped" || bad "status did not follow down"

  json_assert "$($BARDOLIER down myapp --json)" 'd.was_running === false' \
    && ok "down on a stopped project is an idempotent no-op (§2)" || bad "a second down was not a no-op"
fi

# ── 5. delete ─────────────────────────────────────────────────────────────────
head "5. \`delete\` is explicit and confirmed"

REFUSED="$($BARDOLIER delete myapp --json 2>/dev/null || true)"
json_assert "$REFUSED" 'd.error && d.error.code === "INVALID_ARGUMENT"' \
  && ok "delete --json without --force refuses rather than prompting into stdout (§2)" \
  || bad "delete under --json did not refuse"
[ -d "$MOUNTED/myapp" ] && ok "the refused delete left the project alone" || bad "the refused delete removed the project"

CONTRADICTION="$($BARDOLIER delete myapp --force --keep-data --purge --json 2>/dev/null || true)"
json_assert "$CONTRADICTION" 'd.error && d.error.code === "INVALID_ARGUMENT"' \
  && ok "--keep-data and --purge together are refused" || bad "contradictory data flags were accepted"

GHOST="$($BARDOLIER delete ghost --force --json 2>/dev/null || true)"
json_assert "$GHOST" 'd.error && d.error.code === "PROJECT_NOT_FOUND"' \
  && ok "deleting an unknown project is PROJECT_NOT_FOUND" || bad "delete of an unknown project did not fail correctly"

DELETED="$($BARDOLIER delete myapp --force --json)" || bad "delete exited non-zero"
schema_assert delete "$DELETED" && ok "delete --json validates against delete.schema.json" || bad "delete output does not match its schema"
json_assert "$DELETED" 'd.deleted === true' && ok "delete reports success" || bad "delete did not report success"
[ ! -e "$MOUNTED/myapp" ] && ok "the project directory is gone" || bad "the project directory survived delete"

json_assert "$($BARDOLIER status --json)" 'd.projects.length === 0' \
  && ok "status reflects the deletion" || bad "status still lists the deleted project"

GONE="$($BARDOLIER status myapp --json 2>/dev/null || true)"
json_assert "$GONE" 'd.error && d.error.code === "PROJECT_NOT_FOUND"' \
  && ok "the deleted project is no longer addressable" || bad "status still resolves the deleted project"

# ── 6. Renderers stay separate (§2) ───────────────────────────────────────────
head "6. Renderers stay separate (§2)"

$BARDOLIER new humantest --archetype library >/dev/null
HUMAN="$($BARDOLIER down humantest)"
if node -e "JSON.parse(process.argv[1])" "$HUMAN" 2>/dev/null; then
  bad "human down output is JSON — the renderers are not separate"
else
  ok "human output is not JSON"
fi
$BARDOLIER delete humantest --force >/dev/null

# ── 7. Suites, typecheck, and the earlier phases ──────────────────────────────
head "7. Test suites, typecheck, and earlier done-checks"

if npm test >/dev/null 2>&1; then ok "npm test"; else bad "npm test"; fi
if npm run typecheck >/dev/null 2>&1; then ok "npm run typecheck"; else bad "npm run typecheck"; fi
# The ladder is walked ONCE, in order, by test/regression.sh (see its header).
# Recursing here — each check re-running all its predecessors, which did the
# same — made phase 0 come up dozens of times per invocation and turned this
# section into most of the run.
if [ -n "${BARDOLIER_REGRESSION:-}" ]; then
  ok "phases 0-1: already being walked, in order, by test/regression.sh"
else
  LADDER="$(mktemp)"
  if bash test/regression.sh --through 1 >"$LADDER" 2>&1; then
    ok "phases 0-1 still pass (test/regression.sh)"
  else
    bad "an earlier phase regressed — from test/regression.sh:"
    grep -m 6 '✗' "$LADDER" | sed 's/^/      /'
  fi
  rm -f "$LADDER"
fi

# ── Summary ───────────────────────────────────────────────────────────────────
printf '\n\033[1mPhase 2: %d passed, %d failed\033[0m\n' "$pass" "$fail"
[ "$fail" -eq 0 ] || exit 1
printf '\033[32mDone-check passed.\033[0m\n'
