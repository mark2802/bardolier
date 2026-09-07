#!/usr/bin/env bash
# `new` → `up` → `down` → `delete` against a real daemon, plus deterministic
# compose generation and the human/JSON split.
#
#   bash test/lifecycle-done-check.sh
#   BARDOLIER_SKIP_DOCKER=1 …    offline assertions only
#   VERBOSE=1 …                  print every passing line
set -uo pipefail

source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
sandbox

ABSENT="$TMP/nowhere/claude-projects"
track bardolier-myapp
track_volume bardolier-myapp-home

# ── 1. new ────────────────────────────────────────────────────────────────────
head "1. \`new\` creates the project (§6, §10)"

NEW="$($BARDOLIER new myapp --archetype web --json)" || bad "new exited non-zero"
schema_assert new "$NEW" && ok "new --json validates against new.schema.json" || bad "new output does not match its schema"

for file in project.yml docker-compose.yml work/CLAUDE.md; do
  [ -f "$MOUNTED/myapp/$file" ] && ok "wrote $file" || bad "MISSING: $file"
done
for dir in work data local home; do
  [ -d "$MOUNTED/myapp/$dir" ] && ok "created $dir/" || bad "MISSING: $dir/"
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
grep -q 'xcodebuild\|in the container' "$MOUNTED/myapp/work/CLAUDE.md" \
  && ok "seeded CLAUDE.md carries the archetype boundary note (§10)" || bad "CLAUDE.md has no boundary note"
grep -q 'postgres:5432' "$MOUNTED/myapp/work/CLAUDE.md" \
  && ok "seeded CLAUDE.md points at the Docker network, not localhost (§5)" || bad "CLAUDE.md does not steer away from localhost"

# Error paths.
EXISTS="$($BARDOLIER new myapp --archetype web --json 2>/dev/null || true)"
json_assert "$EXISTS" 'd.error && d.error.code === "PROJECT_EXISTS"' \
  && ok "a second new is PROJECT_EXISTS" || bad "duplicate new did not fail PROJECT_EXISTS"

UNMOUNTED="$(BARDOLIER_ROOT="$ABSENT" $BARDOLIER new nope --archetype web --json 2>/dev/null || true)"
# Phase 18: an unreadable TARGET root is ROOT_UNREADABLE, not SSD_NOT_MOUNTED —
# it names the one root this call cares about.
json_assert "$UNMOUNTED" 'd.error && d.error.code === "ROOT_UNREADABLE"' \
  && ok "new with the root absent is ROOT_UNREADABLE" || bad "new did not fail ROOT_UNREADABLE"
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

grep -q '\./work:/work' "$MOUNTED/myapp/docker-compose.yml" \
  && ok "the dev container bind-mounts work/ at /work" || bad "no /work bind mount"
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
  if [ -f "$MOUNTED/myapp/work/from-container.txt" ]; then
    OWNER="$(stat -f '%u' "$MOUNTED/myapp/work/from-container.txt" 2>/dev/null || stat -c '%u' "$MOUNTED/myapp/work/from-container.txt")"
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

  [ -f "$MOUNTED/myapp/work/from-container.txt" ] && [ -f "$MOUNTED/myapp/project.yml" ] \
    && ok "data persists across down" || bad "down destroyed project data"

  json_assert "$($BARDOLIER status myapp --json)" 'd.projects[0].state === "stopped" && d.projects[0].dev_container === null' \
    && ok "status reflects the transition back to stopped" || bad "status did not follow down"

  json_assert "$($BARDOLIER down myapp --json)" 'd.was_running === false' \
    && ok "down on a stopped project is an idempotent no-op (§2)" || bad "a second down was not a no-op"
fi

# ── 5. clone (phase 20) ───────────────────────────────────────────────────────
head "5. \`clone\` reproduces the shape, never the ports"

$BARDOLIER new source --archetype web --services postgres --json >/dev/null || bad "could not create the clone source"
$BARDOLIER port add source api --container-port 8081 --json >/dev/null || bad "port add failed"
$BARDOLIER deps add source libnss3 --json >/dev/null || bad "deps add failed"

SOURCE_BEFORE="$(shasum "$MOUNTED/source/project.yml" | cut -d' ' -f1)"

CLONE="$($BARDOLIER clone source twin --json)" || bad "clone exited non-zero"
schema_assert clone "$CLONE" && ok "clone --json validates against clone.schema.json" || bad "clone output does not match its schema"
json_assert "$CLONE" 'd.source === "source" && d.with_content === false && d.bytes_copied === 0' \
  && ok "a shape clone reports what it did and did not copy" || bad "clone misreported a shape-only copy"

node --input-type=module -e "
  import { readFileSync } from 'node:fs'
  import { parse } from 'yaml'
  const read = (p) => parse(readFileSync(p, 'utf8'))
  const a = read(process.argv[1]), b = read(process.argv[2])
  const shape = (m) => JSON.stringify([m.archetype, m.base_image, m.extra_packages,
    Object.keys(m.services ?? {}).sort(),
    Object.fromEntries(Object.entries(m.extra_ports ?? {}).map(([n, p]) => [n, p.container_port]))])
  if (shape(a) !== shape(b)) { console.error('shape differs'); process.exit(1) }
  const ports = (m) => [m.app_port, ...Object.values(m.services ?? {}).map((s) => s.host_port),
    ...Object.values(m.extra_ports ?? {}).map((p) => p.host_port)]
  if (ports(a).length !== 3) process.exit(1)
  if (ports(a).some((p) => ports(b).includes(p))) { console.error('a host port was copied'); process.exit(1) }
  if (b.name !== 'twin' || b.created === undefined) process.exit(1)
" "$MOUNTED/source/project.yml" "$MOUNTED/twin/project.yml" \
  && ok "the clone's manifest matches the source but for name, created and every host port" \
  || bad "the clone's manifest is not a faithful reshaping of the source"

[ "$SOURCE_BEFORE" = "$(shasum "$MOUNTED/source/project.yml" | cut -d' ' -f1)" ] \
  && ok "the source's project.yml is byte-identical afterwards" || bad "clone modified the source"

TWIN_APP="$(manifest_field twin 'm.app_port')"
grep -q "$TWIN_APP:3000" "$MOUNTED/twin/docker-compose.yml" \
  && ok "compose is rendered from the new manifest, not copied" || bad "the clone's compose file does not carry its own app port"
grep -q 'bardolier-twin' "$MOUNTED/twin/docker-compose.yml" \
  && ok "the clone's compose file names the clone" || bad "the clone's compose file still names the source"
[ ! -e "$MOUNTED/twin/.bardolier" ] && ok "the source's handoff record did not travel" || bad ".bardolier/ was copied"

DUPE="$($BARDOLIER clone source twin --json 2>/dev/null || true)"
json_assert "$DUPE" 'd.error && d.error.code === "PROJECT_EXISTS"' \
  && ok "cloning onto an existing name is PROJECT_EXISTS" || bad "a second clone did not fail PROJECT_EXISTS"

# ── content ───────────────────────────────────────────────────────────────────
mkdir -p "$MOUNTED/source/work" "$MOUNTED/source/data/postgres" "$MOUNTED/source/home"
echo 'the users own file' > "$MOUNTED/source/work/README.md"
echo 'service state' > "$MOUNTED/source/data/postgres/DATA"
echo 'secrets' > "$MOUNTED/source/home/.zsh_history"

FULL="$($BARDOLIER clone source copy --with-content --json)" || bad "clone --with-content exited non-zero"
schema_assert clone "$FULL" && ok "clone --with-content validates against its schema" || bad "clone --with-content broke its schema"
json_assert "$FULL" 'd.with_content === true && d.bytes_copied > 0' \
  && ok "clone --with-content reports the bytes it moved" || bad "clone --with-content reported no content"
[ "$(cat "$MOUNTED/copy/work/README.md")" = 'the users own file' ] \
  && ok "work/ was reproduced" || bad "work/ did not survive the copy"
[ "$(cat "$MOUNTED/copy/data/postgres/DATA")" = 'service state' ] \
  && ok "data/postgres/ was reproduced" || bad "service data did not survive the copy"
[ "$(cat "$MOUNTED/copy/home/.zsh_history")" = 'secrets' ] \
  && ok "home/ was reproduced — a clone is an identical copy" || bad "home/ did not survive the copy"

# ── the Docker half: two projects, disjoint ports ─────────────────────────────
if [ "$DOCKER_OK" = "1" ]; then
  track bardolier-plain bardolier-plaintwin

  $BARDOLIER new plain --archetype web --json >/dev/null || bad "could not create the clone-and-run source"
  $BARDOLIER clone plain plaintwin --json >/dev/null || bad "clone of a runnable project failed"

  $BARDOLIER up plain --json >/dev/null || bad "up plain failed"

  RUNNING="$($BARDOLIER clone plain torn --with-content --json 2>/dev/null || true)"
  json_assert "$RUNNING" 'd.error && d.error.code === "PROJECT_RUNNING"' \
    && ok "clone --with-content of a running project is PROJECT_RUNNING" || bad "a running source was copied anyway"
  [ ! -e "$MOUNTED/torn" ] && ok "the refused copy left no directory behind" || bad "the refused copy left $MOUNTED/torn"

  $BARDOLIER clone plain shapeonly --json >/dev/null \
    && ok "a shape clone of that same running project succeeds" || bad "a shape clone needed the source stopped"
  $BARDOLIER delete shapeonly --force --purge --json >/dev/null

  $BARDOLIER up plaintwin --json >/dev/null || bad "up plaintwin failed"
  json_assert "$($BARDOLIER status --json)" '
    (() => {
      const both = d.projects.filter((p) => p.name === "plain" || p.name === "plaintwin")
      if (both.length !== 2 || both.some((p) => p.state !== "running")) return false
      const ports = both.map((p) => p.app_port)
      return ports.every((p) => typeof p === "number") && ports[0] !== ports[1]
    })()
  ' && ok "clone → up → status: both run at once on disjoint ports" || bad "the clone and its source do not run side by side"

  $BARDOLIER delete plain --force --purge --json >/dev/null
  $BARDOLIER delete plaintwin --force --purge --json >/dev/null
fi

for project in source twin copy; do
  $BARDOLIER delete "$project" --force --purge --json >/dev/null || bad "could not clean up $project"
done

# ── 6. delete ─────────────────────────────────────────────────────────────────
head "6. \`delete\` is explicit and confirmed"

REFUSED="$($BARDOLIER delete myapp --purge --json 2>/dev/null || true)"
json_assert "$REFUSED" 'd.error && d.error.code === "INVALID_ARGUMENT"' \
  && ok "delete --json without --force refuses rather than prompting into stdout (§2)" \
  || bad "delete under --json did not refuse"
[ -d "$MOUNTED/myapp" ] && ok "the refused delete left the project alone" || bad "the refused delete removed the project"

GHOST="$($BARDOLIER delete ghost --force --json 2>/dev/null || true)"
json_assert "$GHOST" 'd.error && d.error.code === "PROJECT_NOT_FOUND"' \
  && ok "deleting an unknown project is PROJECT_NOT_FOUND" || bad "delete of an unknown project did not fail correctly"

# --purge, because the container that just ran left files in home/ and a plain
# delete refuses PROJECT_HAS_DATA rather than destroying them (§6, phase 19).
DELETED="$($BARDOLIER delete myapp --force --purge --json)" || bad "delete exited non-zero"
schema_assert delete "$DELETED" && ok "delete --json validates against delete.schema.json" || bad "delete output does not match its schema"
json_assert "$DELETED" 'd.deleted === true' && ok "delete reports success" || bad "delete did not report success"
[ ! -e "$MOUNTED/myapp" ] && ok "the project directory is gone" || bad "the project directory survived delete"

json_assert "$($BARDOLIER status --json)" 'd.projects.length === 0' \
  && ok "status reflects the deletion" || bad "status still lists the deleted project"

GONE="$($BARDOLIER status myapp --json 2>/dev/null || true)"
json_assert "$GONE" 'd.error && d.error.code === "PROJECT_NOT_FOUND"' \
  && ok "the deleted project is no longer addressable" || bad "status still resolves the deleted project"

# ── 7. Renderers stay separate (§2) ───────────────────────────────────────────
head "7. Renderers stay separate (§2)"

$BARDOLIER new humantest --archetype library >/dev/null
HUMAN="$($BARDOLIER down humantest)"
if node -e "JSON.parse(process.argv[1])" "$HUMAN" 2>/dev/null; then
  bad "human down output is JSON — the renderers are not separate"
else
  ok "human output is not JSON"
fi
$BARDOLIER delete humantest --force >/dev/null

# ── Summary ───────────────────────────────────────────────────────────────────
summary "Lifecycle"
