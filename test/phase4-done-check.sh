#!/usr/bin/env bash
# Phase 4 done-check — THE CONTRACT-FREEZE GATE. The full lifecycle end to end:
# new → service add → up → `shell --json` (run, not merely shaped) → status
# ports → down → service remove → orphan with size → reclaim → delete → eject
# blocked by a shell holding the volume, then clear once it quits.
#
# REAL: Docker, the dev container, postgres, named volumes, sizes from
# `docker system df`, and the lsof holder probe — which runs AFTER Docker has
# bind-mounted the same directory, proving the runtime's own descriptors do not
# stand in for a user's shell (`isRuntimeHolder`).
# STOOD IN: the SSD (temp dir, §8).
# STUBBED: `diskutil eject` alone — a done-check must never unmount a real disk,
# so the Context records the unmount instead of performing it.
#
#   bash test/phase4-done-check.sh
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO"

BANDOLIER="node cli/bin/bandolier.js"
pass=0
fail=0

ok()   { pass=$((pass + 1)); if [ -n "${VERBOSE:-}" ]; then printf '  \033[32m✓\033[0m %s\n' "$1"; fi; }
bad()  { printf '  \033[31m✗\033[0m %s\n' "$1"; fail=$((fail + 1)); }
skip() { printf '  \033[33m–\033[0m %s\n' "$1"; }
head() { printf '\n\033[1m%s\033[0m\n' "$1"; }

# `pwd -P` so the path matches what lsof reports (macOS /var → /private/var).
TMP="$(cd "$(mktemp -d)" && pwd -P)"
HOLDER_PID=""
cleanup() {
  [ -n "$HOLDER_PID" ] && kill "$HOLDER_PID" >/dev/null 2>&1 || true
  if [ "${DOCKER_OK:-0}" = "1" ]; then
    docker rm -f bandolier-alpha bandolier-alpha-postgres bandolier-beta bandolier-beta-redis >/dev/null 2>&1 || true
    docker volume rm alpha_pgdata beta_redisdata >/dev/null 2>&1 || true
  docker volume rm -f bandolier-alpha-home bandolier-beta-home >/dev/null 2>&1 || true
    # Every project now owns a $HOME volume (cli-spec.md §9).
    docker volume rm -f bandolier-alpha-home bandolier-beta-home >/dev/null 2>&1 || true
  fi
  rm -rf "$TMP"
}
trap cleanup EXIT

VOLUME="$TMP/ssd"
MOUNTED="$VOLUME/claude-projects"
mkdir -p "$MOUNTED"

export BANDOLIER_CONFIG="$TMP/config.yml"
export BANDOLIER_SSD_VOLUME="$VOLUME"
export BANDOLIER_SSD_ROOT="$MOUNTED"

json_assert() { # json_assert <json> <js body over `d`>
  node -e "
    const d = JSON.parse(process.argv[1])
    process.exit((${2}) ? 0 : 1)
  " "$1" 2>/dev/null
}

json_value() { # json_value <json> <js expression over `d`>
  node -e "
    const d = JSON.parse(process.argv[1])
    process.stdout.write(String(${2}))
  " "$1" 2>/dev/null
}

schema_assert() { # schema_assert <schema-name> <json>
  node --input-type=module -e "
    import { validate } from './cli/src/schema.ts'
    const { valid, errors } = validate(process.argv[1], JSON.parse(process.argv[2]))
    if (!valid) { console.error(errors.join('\n')); process.exit(1) }
  " "$1" "$2" 2>/dev/null
}

# Drive `eject` with the REAL lsof probe and a RECORDING diskutil (see header).
try_eject() {
  node --input-type=module -e "
    import { createContext } from './cli/src/context.ts'
    import { createSsdDevice } from './cli/src/device.ts'
    import { runEject } from './cli/src/commands/ssd.ts'
    import { toBandolierError } from './cli/src/errors.ts'

    const real = createSsdDevice()
    const unmounted = []
    const device = {
      holders: (mount) => real.holders(mount),
      // Not under test here (see test/phase10-done-check.sh) — this temp dir
      // stands in for a removable SSD, same fiction as every other check.
      removable: async () => true,
      eject: async (mount) => { unmounted.push(mount) },
    }
    try {
      const output = await runEject(createContext({ device }))
      process.stdout.write(JSON.stringify({ output, unmounted }))
    } catch (cause) {
      process.stdout.write(JSON.stringify({ error: toBandolierError(cause).toPayload().error, unmounted }))
    }
  " 2>/dev/null
}

# ── 1. new → service add (no daemon needed) ───────────────────────────────────
head "1. A project with a service attached"

$BANDOLIER new alpha --archetype web --services postgres >/dev/null || bad "new exited non-zero"
PORT="$(node --input-type=module -e "
  import { readFileSync } from 'node:fs'
  import { parse } from 'yaml'
  const m = parse(readFileSync(process.argv[1], 'utf8'))
  process.stdout.write(String(m.services?.postgres?.host_port ?? ''))
" "$MOUNTED/alpha/project.yml" 2>/dev/null)"
[ -n "$PORT" ] && ok "postgres attached on host port $PORT" || bad "no port was assigned"

# ── 2. The Docker half: up → shell → status → down ────────────────────────────
head "2. up → \`shell --json\` resolves → status shows ports → down"

DOCKER_OK=0
if [ "${BANDOLIER_SKIP_DOCKER:-0}" = "1" ]; then
  skip "BANDOLIER_SKIP_DOCKER=1 — skipping the Docker half"
elif ! docker version --format '{{.Server.Version}}' >/dev/null 2>&1; then
  skip "no Docker daemon — skipping the Docker half (the eject checks below still run)"
else
  DOCKER_OK=1
fi

if [ "$DOCKER_OK" = "1" ]; then
  docker rm -f bandolier-alpha bandolier-alpha-postgres bandolier-beta bandolier-beta-redis >/dev/null 2>&1 || true
  docker volume rm alpha_pgdata beta_redisdata >/dev/null 2>&1 || true
  docker volume rm -f bandolier-alpha-home bandolier-beta-home >/dev/null 2>&1 || true

  if ! docker image inspect bandolier-web:latest >/dev/null 2>&1; then
    printf '    building bandolier-web (first run only, this takes a few minutes)…\n'
    $BANDOLIER build --archetype web >/dev/null 2>&1 || bad "bandolier build failed"
  fi

  printf '    starting alpha (pulls postgres:17 on a cold cache)…\n'
  $BANDOLIER up alpha --json >/dev/null || bad "up alpha exited non-zero"

  SHELL_JSON="$($BANDOLIER shell alpha --json)" || bad "shell exited non-zero"
  schema_assert shell "$SHELL_JSON" && ok "shell --json validates against shell.schema.json" || bad "shell output does not match its schema"
  json_assert "$SHELL_JSON" "d.container === 'bandolier-alpha' && Array.isArray(d.exec) && d.exec[0] === 'docker'" \
    && ok "it resolves the dev container and returns an exec ARGV, not a string" || bad "shell did not resolve the container"

  # Prove the command it names actually works. `-it` is dropped because this
  # script has no TTY; everything else is run verbatim.
  CONTAINER="$(json_value "$SHELL_JSON" 'd.container')"
  WORKDIR="$(json_value "$SHELL_JSON" 'd.workdir')"
  IN_CONTAINER="$(docker exec "$CONTAINER" bash -lc 'pwd' 2>/dev/null | tr -d '\r')"
  [ "$IN_CONTAINER" = "$WORKDIR" ] \
    && ok "running it lands a shell in $WORKDIR — the bind-mounted project dir" || bad "the exec command did not land in $WORKDIR (got '$IN_CONTAINER')"
  docker exec "$CONTAINER" bash -lc 'test -f /work/project.yml' >/dev/null 2>&1 \
    && ok "and the project's own manifest is visible from inside it" || bad "the project directory is not mounted at /work"

  STATUS="$($BANDOLIER status alpha --json)"
  schema_assert status "$STATUS" && ok "status still matches the §7 schema" || bad "status broke its schema"
  json_assert "$STATUS" "d.projects[0].state === 'running' && d.projects[0].services[0].host_port === $PORT" \
    && ok "status shows the project running on port $PORT" || bad "status does not report the running service and its port"
  json_assert "$STATUS" 'd.orphaned_volumes.every(v => v.name !== "alpha_pgdata")' \
    && ok "an attached volume is not listed as an orphan (§7)" || bad "a live volume was offered for reclaiming"

  $BANDOLIER down alpha >/dev/null || bad "down alpha exited non-zero"
  STOPPED_SHELL="$($BANDOLIER shell alpha --json 2>/dev/null || true)"
  json_assert "$STOPPED_SHELL" 'd.error && d.error.code === "PROJECT_STOPPED"' \
    && ok "shell on a stopped project is PROJECT_STOPPED, not an auto-start" || bad "shell resolved a stopped project"
fi

# ── 3. remove service → orphan with a size → reclaim ──────────────────────────
head "3. \`service remove\` → orphan appears with a size → \`volumes rm\` reclaims it"

if [ "$DOCKER_OK" = "1" ]; then
  $BANDOLIER service remove alpha postgres --json >/dev/null || bad "service remove exited non-zero"

  ORPHANED="$($BANDOLIER volumes orphaned --json)" || bad "volumes orphaned exited non-zero"
  schema_assert volumes-orphaned "$ORPHANED" && ok "volumes orphaned --json validates against its schema" || bad "volumes orphaned output does not match its schema"
  json_assert "$ORPHANED" 'd.orphaned.some(v => v.name === "alpha_pgdata")' \
    && ok "the detached service's volume is now a listed orphan" || bad "the orphan did not appear"
  json_assert "$ORPHANED" 'd.orphaned.find(v => v.name === "alpha_pgdata").last_project === "alpha"' \
    && ok "it is attributed to the project it came from (§7)" || bad "the orphan was not attributed"
  json_assert "$ORPHANED" 'd.orphaned.find(v => v.name === "alpha_pgdata").size_bytes > 0' \
    && ok "with a real size read from Docker ($(json_value "$ORPHANED" 'd.orphaned.find(v => v.name === "alpha_pgdata").size_human'))" || bad "the orphan has no measured size"
  json_assert "$($BANDOLIER status --json)" 'd.orphaned_volumes.some(v => v.name === "alpha_pgdata")' \
    && ok "status reports the same orphan — one derivation, two commands" || bad "status and volumes orphaned disagree"

  NOTFOUND="$($BANDOLIER volumes rm no_such_volume --force --json 2>/dev/null || true)"
  json_assert "$NOTFOUND" 'd.error && d.error.code === "VOLUME_NOT_FOUND"' \
    && ok "an unknown volume is VOLUME_NOT_FOUND" || bad "an unknown volume was accepted"

  NOCONSENT="$($BANDOLIER volumes rm alpha_pgdata --json 2>/dev/null || true)"
  json_assert "$NOCONSENT" 'd.error && d.error.code === "INVALID_ARGUMENT"' \
    && ok "under --json it refuses to guess at consent for a destructive removal" || bad "volumes rm destroyed data without confirmation"
  docker volume inspect alpha_pgdata >/dev/null 2>&1 \
    && ok "and the volume is still there" || bad "the refused removal removed it anyway"

  RECLAIMED="$($BANDOLIER volumes rm alpha_pgdata --force --json)" || bad "volumes rm exited non-zero"
  schema_assert volumes-rm "$RECLAIMED" && ok "volumes rm --json validates against its schema" || bad "volumes rm output does not match its schema"
  json_assert "$RECLAIMED" 'd.removed === true && d.size_bytes > 0' \
    && ok "it reports what it reclaimed ($(json_value "$RECLAIMED" 'd.size_human'))" || bad "volumes rm reported the wrong outcome"
  docker volume inspect alpha_pgdata >/dev/null 2>&1 \
    && bad "the volume survived its own removal" || ok "the volume is gone"
  json_assert "$($BANDOLIER volumes orphaned --json)" 'd.orphaned.every(v => v.name !== "alpha_pgdata")' \
    && ok "and it is no longer listed" || bad "the reclaimed volume is still listed as an orphan"
else
  skip "no daemon — orphan sizing and reclaiming need real volumes"
fi

# ── 4. In-use refusals (§6) ───────────────────────────────────────────────────
head "4. A claimed volume is never reclaimable"

$BANDOLIER new beta --archetype web --services redis >/dev/null || bad "new beta exited non-zero"
if [ "$DOCKER_OK" = "1" ]; then
  $BANDOLIER up beta --json >/dev/null || bad "up beta exited non-zero"
  $BANDOLIER down beta >/dev/null

  INUSE="$($BANDOLIER volumes rm beta_redisdata --force --json 2>/dev/null || true)"
  json_assert "$INUSE" 'd.error && d.error.code === "VOLUME_IN_USE" && d.error.details.project === "beta"' \
    && ok "a volume beta still attaches is VOLUME_IN_USE, naming the project" || bad "a live volume was removable"
  docker volume inspect beta_redisdata >/dev/null 2>&1 \
    && ok "and its data is untouched" || bad "the refused removal destroyed data"
else
  skip "no daemon — the in-use refusal needs a real volume"
fi

UNMOUNTED="$(BANDOLIER_SSD_ROOT="$TMP/not-mounted" $BANDOLIER volumes orphaned --json 2>/dev/null || true)"
json_assert "$UNMOUNTED" 'd.error && d.error.code === "SSD_NOT_MOUNTED"' \
  && ok "with the SSD absent it refuses rather than calling every volume an orphan" || bad "orphan listing answered without the manifests"

# ── 5. delete, then down-all ──────────────────────────────────────────────────
head "5. \`delete\` and \`down-all\`"

DELETED="$($BANDOLIER delete alpha --force --json)" || bad "delete exited non-zero"
json_assert "$DELETED" 'd.deleted === true' && ok "alpha is deleted" || bad "delete reported the wrong outcome"
[ ! -e "$MOUNTED/alpha" ] && ok "its directory is gone" || bad "the project directory survived"

DOWNALL="$($BANDOLIER down-all --json)" || bad "down-all exited non-zero"
schema_assert down-all "$DOWNALL" && ok "down-all --json validates against down-all.schema.json" || bad "down-all output does not match its schema"
json_assert "$DOWNALL" 'Array.isArray(d.projects) && Array.isArray(d.stopped)' \
  && ok "it reports every project it considered" || bad "down-all reported nothing"

if [ "$DOCKER_OK" = "1" ]; then
  $BANDOLIER up beta --json >/dev/null || bad "up beta (second time) exited non-zero"
  RUNNING_BEFORE="$(docker ps --format '{{.Names}}' | grep -c '^bandolier-beta' || true)"
  [ "$RUNNING_BEFORE" -ge 1 ] && ok "beta is up ($RUNNING_BEFORE container(s))" || bad "beta did not start"
  DOWNALL2="$($BANDOLIER down-all --json)" || bad "down-all exited non-zero"
  json_assert "$DOWNALL2" 'd.stopped.includes("beta")' \
    && ok "down-all stopped it" || bad "down-all did not stop a running project"
  [ "$(docker ps --format '{{.Names}}' | grep -c '^bandolier-beta' || true)" = "0" ] \
    && ok "and no bandolier container is left running" || bad "a bandolier container survived down-all"
  docker volume inspect beta_redisdata >/dev/null 2>&1 \
    && ok "down-all kept the data, like down does" || bad "down-all removed a named volume"
fi

# ── 6. eject: blocked by a real holder, then clear ────────────────────────────
head "6. \`eject\` is blocked while a shell sits in the SSD, and clear once it quits"

# A real background shell whose cwd IS the stand-in SSD — the same thing lsof
# sees when a terminal is cd'd into /Volumes/ssd.
( cd "$VOLUME" && exec sleep 120 ) &
HOLDER_PID=$!
sleep 0.5

BLOCKED="$(try_eject)"
json_assert "$BLOCKED" 'd.error && d.error.code === "EJECT_BLOCKED"' \
  && ok "a held volume is EJECT_BLOCKED" || bad "eject was not blocked by a live holder (is lsof present?)"
json_assert "$BLOCKED" "d.error.details.holders.some(h => h.pid === $HOLDER_PID)" \
  && ok "and the refusal names the holding process (pid $HOLDER_PID)" || bad "the holders list does not include the process holding it"
json_assert "$BLOCKED" 'd.unmounted.length === 0' \
  && ok "nothing was unmounted — it never forces" || bad "a blocked eject unmounted anyway"

kill "$HOLDER_PID" >/dev/null 2>&1 || true
wait "$HOLDER_PID" 2>/dev/null || true
HOLDER_PID=""
sleep 0.5

CLEAR="$(try_eject)"
json_assert "$CLEAR" 'd.output && d.output.ejected === true' \
  && ok "with the holder gone, the same volume ejects" \
  || bad "eject still refused after the holder quit: $(json_value "$CLEAR" 'JSON.stringify(d.error ?? d)')"
schema_assert eject "$(json_value "$CLEAR" 'JSON.stringify(d.output)')" \
  && ok "eject --json validates against eject.schema.json" || bad "eject output does not match its schema"
json_assert "$CLEAR" 'd.unmounted.length === 1' \
  && ok "and the unmount was reached exactly once" || bad "the unmount did not happen"

GONE="$(BANDOLIER_SSD_VOLUME="$TMP/not-a-volume" $BANDOLIER eject --json 2>/dev/null || true)"
json_assert "$GONE" 'd.error && d.error.code === "SSD_NOT_MOUNTED"' \
  && ok "ejecting what is not mounted is SSD_NOT_MOUNTED" || bad "eject accepted an absent volume"

# ── 7. Renderers stay separate (§2) ───────────────────────────────────────────
head "7. Renderers stay separate (§2)"

HUMAN="$($BANDOLIER volumes orphaned)"
if node -e "JSON.parse(process.argv[1])" "$HUMAN" 2>/dev/null; then
  bad "human volumes output is JSON — the renderers are not separate"
else
  ok "human output is not JSON"
fi

if [ "$DOCKER_OK" = "1" ]; then
  $BANDOLIER up beta --json >/dev/null || bad "up beta (third time) exited non-zero"
  PRINTED="$($BANDOLIER shell beta --print)"
  [ "$PRINTED" = "docker exec -it bandolier-beta bash" ] \
    && ok "\`shell --print\` prints exactly the command to run" || bad "shell --print printed '$PRINTED'"
  $BANDOLIER down-all >/dev/null
fi

# ── 8. Suites, typecheck, and the earlier phases ──────────────────────────────
head "8. Test suites, typecheck, and earlier done-checks"

if npm test >/dev/null 2>&1; then ok "npm test"; else bad "npm test"; fi
if npm run typecheck >/dev/null 2>&1; then ok "npm run typecheck"; else bad "npm run typecheck"; fi
# The ladder is walked ONCE, in order, by test/regression.sh (see its header).
# Recursing here — each check re-running all its predecessors, which did the
# same — made phase 0 come up dozens of times per invocation and turned this
# section into most of the run.
if [ -n "${BANDOLIER_REGRESSION:-}" ]; then
  ok "phases 0-3: already being walked, in order, by test/regression.sh"
else
  LADDER="$(mktemp)"
  if bash test/regression.sh --through 3 >"$LADDER" 2>&1; then
    ok "phases 0-3 still pass (test/regression.sh)"
  else
    bad "an earlier phase regressed — from test/regression.sh:"
    grep -m 6 '✗' "$LADDER" | sed 's/^/      /'
  fi
  rm -f "$LADDER"
fi

# ── Summary ───────────────────────────────────────────────────────────────────
printf '\n\033[1mPhase 4: %d passed, %d failed\033[0m\n' "$pass" "$fail"
[ "$fail" -eq 0 ] || exit 1
printf '\033[32mDone-check passed. Contracts are frozen: schema changes are additive only.\033[0m\n'
