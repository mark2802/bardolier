#!/usr/bin/env bash
# What the disk holds and how it is let go: orphans and their size, the in-use
# refusals, `down-all`, and an `eject` blocked by a real holder then cleared.
#
#   bash test/disk-done-check.sh
#   BARDOLIER_SKIP_DOCKER=1 …    offline assertions only
#   VERBOSE=1 …                  print every passing line
set -uo pipefail

source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
sandbox

VOLUME="$TMP/ssd"
track bardolier-myapp bardolier-myapp-postgres
track_volume bardolier-myapp-home

try_eject() {
  node --input-type=module -e "
    import { createContext } from './cli/src/context.ts'
    import { createSsdDevice } from './cli/src/device.ts'
    import { runEject } from './cli/src/commands/ssd.ts'
    import { toBardolierError } from './cli/src/errors.ts'

    const real = createSsdDevice()
    const unmounted = []
    const device = {
      // containingVolume() walks up by device number, and firmlinks make any
      // path under \$TMPDIR resolve to the boot volume (/) on real macOS — so
      // runEject asks holders() about \"/\", not our stand-in directory. \"/\"
      // is never free of real holders (Finder, Dock, loginwindow, …), so the
      // eject-clears-once-the-holder-quits assertion below could never pass.
      // Query the actual stand-in directory instead — the one thing under
      // test here is real lsof output for a real holder, not mount resolution.
      holders: () => real.holders('$VOLUME'),
      // Not under test here — this temp dir stands in for a removable SSD,
      // same fiction as every other check.
      removable: async () => true,
      eject: async (mount) => { unmounted.push(mount) },
    }
    try {
      const output = await runEject(createContext({ device }))
      process.stdout.write(JSON.stringify({ output, unmounted }))
    } catch (cause) {
      process.stdout.write(JSON.stringify({ error: toBardolierError(cause).toPayload().error, unmounted }))
    }
  " 2>/dev/null
}

# ── 1. new → service add (no daemon needed) ───────────────────────────────────
head "1. A project with a service attached"

$BARDOLIER new alpha --archetype web --services postgres >/dev/null || bad "new exited non-zero"
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
if [ "${BARDOLIER_SKIP_DOCKER:-0}" = "1" ]; then
  skip "BARDOLIER_SKIP_DOCKER=1 — skipping the Docker half"
elif ! docker version --format '{{.Server.Version}}' >/dev/null 2>&1; then
  skip "no Docker daemon — skipping the Docker half (the eject checks below still run)"
else
  DOCKER_OK=1
fi

if [ "$DOCKER_OK" = "1" ]; then
  docker rm -f bardolier-alpha bardolier-alpha-postgres bardolier-beta bardolier-beta-redis >/dev/null 2>&1 || true

  if ! docker image inspect bardolier-web:latest >/dev/null 2>&1; then
    printf '    building bardolier-web (first run only, this takes a few minutes)…\n'
    $BARDOLIER build --archetype web >/dev/null 2>&1 || bad "bardolier build failed"
  fi

  printf '    starting alpha (pulls postgres:17 on a cold cache)…\n'
  $BARDOLIER up alpha --json >/dev/null || bad "up alpha exited non-zero"

  SHELL_JSON="$($BARDOLIER shell alpha --json)" || bad "shell exited non-zero"
  schema_assert shell "$SHELL_JSON" && ok "shell --json validates against shell.schema.json" || bad "shell output does not match its schema"
  json_assert "$SHELL_JSON" "d.container === 'bardolier-alpha' && Array.isArray(d.exec) && d.exec[0] === 'docker'" \
    && ok "it resolves the dev container and returns an exec ARGV, not a string" || bad "shell did not resolve the container"

  # Prove the command it names actually works. `-it` is dropped because this
  # script has no TTY; everything else is run verbatim.
  CONTAINER="$(json_value "$SHELL_JSON" 'd.container')"
  WORKDIR="$(json_value "$SHELL_JSON" 'd.workdir')"
  IN_CONTAINER="$(docker exec "$CONTAINER" bash -lc 'pwd' 2>/dev/null | tr -d '\r')"
  [ "$IN_CONTAINER" = "$WORKDIR" ] \
    && ok "running it lands a shell in $WORKDIR — the bind-mounted project dir" || bad "the exec command did not land in $WORKDIR (got '$IN_CONTAINER')"
  # `work/` is mounted, and the manifest above it deliberately is NOT (§3).
  docker exec "$CONTAINER" bash -lc 'test -f /work/CLAUDE.md' >/dev/null 2>&1 \
    && ok "and the seeded work/CLAUDE.md is visible from inside it" || bad "work/ is not mounted at /work"
  docker exec "$CONTAINER" bash -lc 'test -e /work/project.yml' >/dev/null 2>&1 \
    && bad "project.yml is reachable from the container" || ok "project.yml is above work/ and invisible from in there"
  docker exec "$CONTAINER" bash -lc 'test -w /data' >/dev/null 2>&1 \
    && bad "/data is writable from the dev container" || ok "/data is mounted read-only (§9)"

  STATUS="$($BARDOLIER status alpha --json)"
  schema_assert status "$STATUS" && ok "status still matches the §7 schema" || bad "status broke its schema"
  json_assert "$STATUS" "d.projects[0].state === 'running' && d.projects[0].services[0].host_port === $PORT" \
    && ok "status shows the project running on port $PORT" || bad "status does not report the running service and its port"
  json_assert "$STATUS" 'd.orphaned_volumes.every(v => v.name !== "alpha/postgres")' \
    && ok "attached data is not listed as an orphan (§7)" || bad "live data was offered for reclaiming"

  $BARDOLIER down alpha >/dev/null || bad "down alpha exited non-zero"
  STOPPED_SHELL="$($BARDOLIER shell alpha --json 2>/dev/null || true)"
  json_assert "$STOPPED_SHELL" 'd.error && d.error.code === "PROJECT_STOPPED"' \
    && ok "shell on a stopped project is PROJECT_STOPPED, not an auto-start" || bad "shell resolved a stopped project"
fi

# ── 3. remove service → orphan with a size → reclaim ──────────────────────────
head "3. \`service remove\` → orphan appears with a size → \`volumes rm\` reclaims it"

if [ "$DOCKER_OK" = "1" ]; then
  $BARDOLIER service remove alpha postgres --json >/dev/null || bad "service remove exited non-zero"

  ORPHANED="$($BARDOLIER volumes orphaned --json)" || bad "volumes orphaned exited non-zero"
  schema_assert volumes-orphaned "$ORPHANED" && ok "volumes orphaned --json validates against its schema" || bad "volumes orphaned output does not match its schema"
  json_assert "$ORPHANED" 'd.orphaned.some(v => v.name === "alpha/postgres" && v.kind === "directory")' \
    && ok "the detached service's data directory is now a listed orphan" || bad "the orphan did not appear"
  json_assert "$ORPHANED" 'd.orphaned.find(v => v.name === "alpha/postgres").last_project === "alpha"' \
    && ok "it is attributed to the project that holds it (§7)" || bad "the orphan was not attributed"
  json_assert "$ORPHANED" "d.orphaned.find(v => v.name === 'alpha/postgres').path === '$MOUNTED/alpha/data/postgres'" \
    && ok "and carries the path a human can go and look at" || bad "the orphan has no path"
  json_assert "$ORPHANED" 'd.orphaned.find(v => v.name === "alpha/postgres").size_bytes > 0' \
    && ok "with a real size measured on disk ($(json_value "$ORPHANED" 'd.orphaned.find(v => v.name === "alpha/postgres").size_human'))" || bad "the orphan has no measured size"
  json_assert "$($BARDOLIER status --json)" 'd.orphaned_volumes.some(v => v.name === "alpha/postgres")' \
    && ok "status reports the same orphan — one derivation, two commands" || bad "status and volumes orphaned disagree"

  NOTFOUND="$($BARDOLIER volumes rm no_such_volume --force --json 2>/dev/null || true)"
  json_assert "$NOTFOUND" 'd.error && d.error.code === "VOLUME_NOT_FOUND"' \
    && ok "an unknown name is VOLUME_NOT_FOUND" || bad "an unknown name was accepted"

  NOCONSENT="$($BARDOLIER volumes rm alpha/postgres --json 2>/dev/null || true)"
  json_assert "$NOCONSENT" 'd.error && d.error.code === "INVALID_ARGUMENT"' \
    && ok "under --json it refuses to guess at consent for a destructive removal" || bad "volumes rm destroyed data without confirmation"
  [ -d "$MOUNTED/alpha/data/postgres" ] \
    && ok "and the data is still there" || bad "the refused removal removed it anyway"

  RECLAIMED="$($BARDOLIER volumes rm alpha/postgres --force --json)" || bad "volumes rm exited non-zero"
  schema_assert volumes-rm "$RECLAIMED" && ok "volumes rm --json validates against its schema" || bad "volumes rm output does not match its schema"
  json_assert "$RECLAIMED" 'd.removed === true && d.kind === "directory" && d.size_bytes > 0' \
    && ok "it reports what it reclaimed ($(json_value "$RECLAIMED" 'd.size_human'))" || bad "volumes rm reported the wrong outcome"
  [ -d "$MOUNTED/alpha/data/postgres" ] \
    && bad "the directory survived its own removal" || ok "the data directory is gone"
  json_assert "$($BARDOLIER volumes orphaned --json)" 'd.orphaned.every(v => v.name !== "alpha/postgres")' \
    && ok "and it is no longer listed" || bad "the reclaimed orphan is still listed"
else
  skip "no daemon — orphan sizing and reclaiming need real data on disk"
fi

# ── 4. In-use refusals (§6) ───────────────────────────────────────────────────
head "4. A claimed volume is never reclaimable"

$BARDOLIER new beta --archetype web --services redis >/dev/null || bad "new beta exited non-zero"
if [ "$DOCKER_OK" = "1" ]; then
  $BARDOLIER up beta --json >/dev/null || bad "up beta exited non-zero"
  $BARDOLIER down beta >/dev/null

  INUSE="$($BARDOLIER volumes rm beta/redis --force --json 2>/dev/null || true)"
  json_assert "$INUSE" 'd.error && d.error.code === "VOLUME_IN_USE" && d.error.details.project === "beta"' \
    && ok "data beta still attaches is VOLUME_IN_USE, naming the project" || bad "live data was removable"
  [ -d "$MOUNTED/beta/data/redis" ] \
    && ok "and its data is untouched" || bad "the refused removal destroyed data"
else
  skip "no daemon — the in-use refusal needs real data on disk"
fi

UNMOUNTED="$(BARDOLIER_ROOT="$TMP/not-mounted" $BARDOLIER volumes orphaned --json 2>/dev/null || true)"
json_assert "$UNMOUNTED" 'd.error && d.error.code === "SSD_NOT_MOUNTED"' \
  && ok "with the SSD absent it refuses rather than calling every volume an orphan" || bad "orphan listing answered without the manifests"

# ── 5. delete, then down-all ──────────────────────────────────────────────────
head "5. \`delete\` and \`down-all\`"

# --purge: alpha has run, so its home/ holds the container's dotfiles and a
# plain delete refuses PROJECT_HAS_DATA rather than destroying them (§6).
DELETED="$($BARDOLIER delete alpha --force --purge --json)" || bad "delete exited non-zero"
json_assert "$DELETED" 'd.deleted === true' && ok "alpha is deleted" || bad "delete reported the wrong outcome"
[ ! -e "$MOUNTED/alpha" ] && ok "its directory is gone" || bad "the project directory survived"

DOWNALL="$($BARDOLIER down-all --json)" || bad "down-all exited non-zero"
schema_assert down-all "$DOWNALL" && ok "down-all --json validates against down-all.schema.json" || bad "down-all output does not match its schema"
json_assert "$DOWNALL" 'Array.isArray(d.projects) && Array.isArray(d.stopped)' \
  && ok "it reports every project it considered" || bad "down-all reported nothing"

if [ "$DOCKER_OK" = "1" ]; then
  $BARDOLIER up beta --json >/dev/null || bad "up beta (second time) exited non-zero"
  RUNNING_BEFORE="$(docker ps --format '{{.Names}}' | grep -c '^bardolier-beta' || true)"
  [ "$RUNNING_BEFORE" -ge 1 ] && ok "beta is up ($RUNNING_BEFORE container(s))" || bad "beta did not start"
  DOWNALL2="$($BARDOLIER down-all --json)" || bad "down-all exited non-zero"
  json_assert "$DOWNALL2" 'd.stopped.includes("beta")' \
    && ok "down-all stopped it" || bad "down-all did not stop a running project"
  [ "$(docker ps --format '{{.Names}}' | grep -c '^bardolier-beta' || true)" = "0" ] \
    && ok "and no bardolier container is left running" || bad "a bardolier container survived down-all"
  [ -d "$MOUNTED/beta/data/redis" ] \
    && ok "down-all kept the data, like down does" || bad "down-all destroyed project data"
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

GONE="$(BARDOLIER_ROOT="$TMP/not-a-volume" $BARDOLIER eject --json 2>/dev/null || true)"
json_assert "$GONE" 'd.error && d.error.code === "SSD_NOT_MOUNTED"' \
  && ok "ejecting what is not mounted is SSD_NOT_MOUNTED" || bad "eject accepted an absent volume"

# ── 7. Renderers stay separate (§2) ───────────────────────────────────────────
head "7. Renderers stay separate (§2)"

HUMAN="$($BARDOLIER volumes orphaned)"
if node -e "JSON.parse(process.argv[1])" "$HUMAN" 2>/dev/null; then
  bad "human volumes output is JSON — the renderers are not separate"
else
  ok "human output is not JSON"
fi

if [ "$DOCKER_OK" = "1" ]; then
  $BARDOLIER up beta --json >/dev/null || bad "up beta (third time) exited non-zero"
  PRINTED="$($BARDOLIER shell beta --print)"
  [ "$PRINTED" = "docker exec -it bardolier-beta bash" ] \
    && ok "\`shell --print\` prints exactly the command to run" || bad "shell --print printed '$PRINTED'"
  $BARDOLIER down-all >/dev/null
fi

# ── Summary ───────────────────────────────────────────────────────────────────
summary "Disk"
