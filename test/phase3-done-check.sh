#!/usr/bin/env bash
# Phase 3 done-check — implementation-plan.md.
#
#   "add postgres to two projects → each gets a distinct host port in its band →
#    both `up` → connect from a host GUI to each on its port → restart one →
#    port unchanged → remove from one → volume orphaned, port released → the
#    freed port is reused by the next add."
#
# "Connect from a host GUI" is stood in for by a TCP connect from this machine
# to the published port — the same thing TablePlus does first, and the only part
# of it a script can assert.
#
# The SSD is stood in for with CPROJ_SSD_ROOT against a temp dir (§8), so this
# runs with no SSD attached. The Docker half is real; set CPROJ_SKIP_DOCKER=1 to
# run only the offline assertions.
#
# Keep this script: per CLAUDE.md, each CLI phase's done-check becomes a
# regression check.
#
#   bash test/phase3-done-check.sh
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO"

CPROJ="node cli/bin/cproj.js"
pass=0
fail=0

ok()   { printf '  \033[32m✓\033[0m %s\n' "$1"; pass=$((pass + 1)); }
bad()  { printf '  \033[31m✗\033[0m %s\n' "$1"; fail=$((fail + 1)); }
skip() { printf '  \033[33m–\033[0m %s\n' "$1"; }
head() { printf '\n\033[1m%s\033[0m\n' "$1"; }

TMP="$(mktemp -d)"
cleanup() {
  if [ "${DOCKER_OK:-0}" = "1" ]; then
    docker rm -f cproj-alpha cproj-alpha-postgres cproj-beta cproj-beta-postgres >/dev/null 2>&1 || true
    docker volume rm alpha_pgdata beta_pgdata >/dev/null 2>&1 || true
  fi
  rm -rf "$TMP"
}
trap cleanup EXIT

MOUNTED="$TMP/ssd/claude-projects"
mkdir -p "$MOUNTED"

export CPROJ_CONFIG="$TMP/config.yml"
export CPROJ_SSD_VOLUME="$TMP/ssd"
export CPROJ_SSD_ROOT="$MOUNTED"

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

manifest_port() { # manifest_port <project> <service>
  node --input-type=module -e "
    import { readFileSync } from 'node:fs'
    import { parse } from 'yaml'
    const m = parse(readFileSync(process.argv[1], 'utf8'))
    process.stdout.write(String(m.services?.[process.argv[2]]?.host_port ?? ''))
  " "$MOUNTED/$1/project.yml" "$2" 2>/dev/null
}

tcp_connect() { # tcp_connect <port> — retries for up to ~30s
  node -e "
    const net = require('node:net')
    const port = Number(process.argv[1])
    const deadline = Date.now() + 30000
    const attempt = () => {
      const socket = net.connect({ host: '127.0.0.1', port })
      socket.once('connect', () => { socket.destroy(); process.exit(0) })
      socket.once('error', () => {
        socket.destroy()
        if (Date.now() > deadline) process.exit(1)
        setTimeout(attempt, 500)
      })
    }
    attempt()
  " "$1" 2>/dev/null
}

# ── 1. Two projects, two ports (§5.1, §5.4) ───────────────────────────────────
head "1. \`service add\` assigns distinct ports in the band (§5)"

$CPROJ new alpha --archetype web >/dev/null
$CPROJ new beta --archetype web >/dev/null

ADD_A="$($CPROJ service add alpha postgres --json)" || bad "service add exited non-zero"
schema_assert service-add "$ADD_A" && ok "service add --json validates against service-add.schema.json" || bad "service add output does not match its schema"

ADD_B="$($CPROJ service add beta postgres --json)" || bad "the second service add exited non-zero"

PORT_A="$(json_value "$ADD_A" 'd.added.host_port')"
PORT_B="$(json_value "$ADD_B" 'd.added.host_port')"

[ -n "$PORT_A" ] && [ -n "$PORT_B" ] && [ "$PORT_A" != "$PORT_B" ] \
  && ok "each project got a distinct host port ($PORT_A, $PORT_B)" || bad "ports collided or were missing: '$PORT_A' / '$PORT_B'"
[ "$PORT_A" -ge 5432 ] && [ "$PORT_A" -lt 5944 ] && [ "$PORT_B" -ge 5432 ] && [ "$PORT_B" -lt 5944 ] \
  && ok "both ports sit in the postgres band, counting up from 5432 (§5.4)" || bad "a port landed outside the postgres band"

[ "$(manifest_port alpha postgres)" = "$PORT_A" ] \
  && ok "the port is persisted in project.yml — the single registry (§4.2, §5.2)" || bad "project.yml does not record the assigned port"

grep -q "$PORT_A:5432" "$MOUNTED/alpha/docker-compose.yml" \
  && ok "compose publishes host:container for the service (§9)" || bad "the compose file does not publish the port"
grep -q 'alpha_pgdata:/var/lib/postgresql/data' "$MOUNTED/alpha/docker-compose.yml" \
  && ok "the service carries its named volume (§9)" || bad "no named volume in the compose file"
grep -q 'POSTGRES_DB: alpha' "$MOUNTED/alpha/docker-compose.yml" \
  && ok "{project} is interpolated into the service env (§9)" || bad "service env was not interpolated"

LIST="$($CPROJ service list alpha --json)"
schema_assert service-list "$LIST" && ok "service list --json validates against service-list.schema.json" || bad "service list output does not match its schema"
json_assert "$LIST" "d.services.length === 1 && d.services[0].key === 'postgres' && d.services[0].host_port === $PORT_A && d.services[0].container_port === 5432" \
  && ok "service list resolves the attached service and its port" || bad "service list is wrong"
json_assert "$LIST" "d.services[0].connection_hint.includes(':$PORT_A')" \
  && ok "the connection hint names the host port — the debugging tap (§5.3)" || bad "the connection hint is wrong"

STATUS="$($CPROJ status alpha --json)"
schema_assert status "$STATUS" && ok "status still matches the §7 schema with a service attached" || bad "status broke its schema"
json_assert "$STATUS" "d.projects[0].services[0].host_port === $PORT_A" \
  && ok "status reports the assigned port" || bad "status does not report the port"

# ── 2. new --services allocates at creation ───────────────────────────────────
head "2. \`new --services\` allocates at creation (§6)"

NEW="$($CPROJ new gamma --archetype library --services redis,postgres --json)"
schema_assert new "$NEW" && ok "new --json still validates with services attached" || bad "new output does not match its schema"
json_assert "$NEW" "d.services.map(s => s.key).join(',') === 'postgres,redis'" \
  && ok "services are attached in a stable, sorted order (determinism)" || bad "new --services did not attach both, sorted"
json_assert "$NEW" "d.services.every(s => s.host_port > 0) && new Set(d.services.map(s => s.host_port)).size === 2" \
  && ok "each attached service got its own port" || bad "new --services did not allocate distinct ports"
json_assert "$NEW" "d.services.find(s => s.key === 'redis').host_port >= 6379" \
  && ok "redis landed in the redis band, not the postgres one (§5.4)" || bad "redis was allocated outside its band"

UNKNOWN="$($CPROJ new delta --archetype web --services toaster --json 2>/dev/null || true)"
json_assert "$UNKNOWN" 'd.error && d.error.code === "SERVICE_UNKNOWN"' \
  && ok "an unknown service key is SERVICE_UNKNOWN" || bad "an unknown service key was accepted"
[ ! -e "$MOUNTED/delta" ] && ok "the rejected new created nothing" || bad "a half-made project was left behind"

# ── 3. Error paths (§6) ───────────────────────────────────────────────────────
head "3. The §6 error paths"

DUP="$($CPROJ service add alpha postgres --json 2>/dev/null || true)"
json_assert "$DUP" 'd.error && d.error.code === "SERVICE_ATTACHED"' \
  && ok "attaching twice is SERVICE_ATTACHED" || bad "a duplicate attach was accepted"

BADSVC="$($CPROJ service add alpha toaster --json 2>/dev/null || true)"
json_assert "$BADSVC" 'd.error && d.error.code === "SERVICE_UNKNOWN"' \
  && ok "an unknown catalogue key is SERVICE_UNKNOWN" || bad "an unknown key was accepted"

NOTATT="$($CPROJ service remove alpha mongo --json 2>/dev/null || true)"
json_assert "$NOTATT" 'd.error && d.error.code === "SERVICE_NOT_ATTACHED"' \
  && ok "detaching what is not attached is SERVICE_NOT_ATTACHED" || bad "a bogus detach was accepted"

GHOST="$($CPROJ service list ghost --json 2>/dev/null || true)"
json_assert "$GHOST" 'd.error && d.error.code === "PROJECT_NOT_FOUND"' \
  && ok "an unknown project is PROJECT_NOT_FOUND" || bad "service list resolved a project that does not exist"

# ── 4. Determinism with services attached (§9) ────────────────────────────────
head "4. Compose generation stays deterministic with services (§9)"

BEFORE="$(shasum "$MOUNTED/gamma/docker-compose.yml" | cut -d' ' -f1)"
node --input-type=module -e "
  import { readFileSync } from 'node:fs'
  import { parse } from 'yaml'
  import { regenerateCompose } from './cli/src/workspace.ts'
  import { resolveCatalogue } from './cli/src/catalogue.ts'
  import { loadConfig } from './cli/src/config.ts'
  const dir = process.argv[1]
  const { config } = loadConfig({})
  const catalogue = resolveCatalogue(config).catalogue
  const manifest = parse(readFileSync(dir + '/project.yml', 'utf8'))
  const first = regenerateCompose(dir, manifest, catalogue)
  const second = regenerateCompose(dir, manifest, catalogue)
  if (first.changed || second.changed) { console.error('regeneration was not a no-op'); process.exit(1) }
" "$MOUNTED/gamma" 2>/dev/null \
  && ok "regenerating a manifest with services is a no-op" || bad "regeneration reported a spurious change"
[ "$BEFORE" = "$(shasum "$MOUNTED/gamma/docker-compose.yml" | cut -d' ' -f1)" ] \
  && ok "the bytes are identical across regenerations" || bad "the compose file changed on regeneration"

# ── 5. The Docker half: up → connect → restart → port unchanged ───────────────
head "5. Both projects up, both ports reachable from the host"

DOCKER_OK=0
if [ "${CPROJ_SKIP_DOCKER:-0}" = "1" ]; then
  skip "CPROJ_SKIP_DOCKER=1 — skipping the Docker half"
elif ! docker version --format '{{.Server.Version}}' >/dev/null 2>&1; then
  skip "no Docker daemon — skipping the Docker half (the offline checks above still ran)"
else
  DOCKER_OK=1
fi

if [ "$DOCKER_OK" = "1" ]; then
  docker rm -f cproj-alpha cproj-alpha-postgres cproj-beta cproj-beta-postgres >/dev/null 2>&1 || true
  docker volume rm alpha_pgdata beta_pgdata >/dev/null 2>&1 || true

  if ! docker image inspect claude-web:latest >/dev/null 2>&1; then
    printf '    building claude-web (first run only, this takes a few minutes)…\n'
    $CPROJ build --archetype web >/dev/null 2>&1 || bad "cproj build failed"
  fi

  printf '    starting alpha and beta (pulls postgres:17 on a cold cache)…\n'
  UP_A="$($CPROJ up alpha --json)" || bad "up alpha exited non-zero"
  UP_B="$($CPROJ up beta --json)" || bad "up beta exited non-zero"

  json_assert "$UP_A" "d.state === 'running' && d.services[0].host_port === $PORT_A" \
    && ok "alpha is running and published $PORT_A" || bad "alpha did not come up with its service"
  json_assert "$UP_B" "d.state === 'running' && d.services[0].host_port === $PORT_B" \
    && ok "beta is running and published $PORT_B" || bad "beta did not come up with its service"

  tcp_connect "$PORT_A" && ok "a host client can connect to alpha's postgres on $PORT_A" || bad "nothing is listening on $PORT_A"
  tcp_connect "$PORT_B" && ok "a host client can connect to beta's postgres on $PORT_B" || bad "nothing is listening on $PORT_B"

  json_assert "$($CPROJ status --json)" \
    "d.projects.filter(p => p.services.some(s => s.state === 'running')).length === 2" \
    && ok "status shows both services running on their own ports" || bad "status does not see both services running"

  RUNNING_ADD="$($CPROJ service add alpha redis --json 2>/dev/null || true)"
  json_assert "$RUNNING_ADD" 'd.error && d.error.code === "PROJECT_RUNNING"' \
    && ok "service add on a running project is PROJECT_RUNNING" || bad "a running project accepted a service add"
  RUNNING_RM="$($CPROJ service remove alpha postgres --json 2>/dev/null || true)"
  json_assert "$RUNNING_RM" 'd.error && d.error.code === "PROJECT_RUNNING"' \
    && ok "service remove on a running project is PROJECT_RUNNING" || bad "a running project accepted a service remove"
  [ "$(manifest_port alpha postgres)" = "$PORT_A" ] \
    && ok "the refused changes left the manifest untouched" || bad "a refused change mutated the manifest"

  # Restart one: the port must survive (§5.2).
  $CPROJ down alpha >/dev/null || bad "down alpha exited non-zero"
  RESTART="$($CPROJ up alpha --json)" || bad "restarting alpha exited non-zero"
  json_assert "$RESTART" "d.services[0].host_port === $PORT_A" \
    && ok "alpha's port is unchanged across a restart (§5.2)" || bad "the port moved on restart"
  [ "$(manifest_port alpha postgres)" = "$PORT_A" ] \
    && ok "and the manifest still records the same port" || bad "the manifest changed across a restart"
  tcp_connect "$PORT_A" && ok "the same port is reachable again after the restart" || bad "$PORT_A is not listening after the restart"

  # ── remove: volume orphaned, port released ──────────────────────────────────
  head "6. \`service remove\` orphans the volume and releases the port"

  $CPROJ down alpha >/dev/null
  REMOVED="$($CPROJ service remove alpha postgres --json)" || bad "service remove exited non-zero"
  schema_assert service-remove "$REMOVED" && ok "service remove --json validates against service-remove.schema.json" || bad "service remove output does not match its schema"
  json_assert "$REMOVED" "d.removed.host_port === $PORT_A && d.removed.volume === 'alpha_pgdata' && d.services.length === 0" \
    && ok "it reports the released port and the kept volume" || bad "service remove reported the wrong outcome"

  docker volume inspect alpha_pgdata >/dev/null 2>&1 \
    && ok "the data volume survives — it is now an orphan" || bad "detaching destroyed the volume"
  [ -z "$(manifest_port alpha postgres)" ] \
    && ok "the manifest no longer claims the port" || bad "the manifest still records the removed service"
  grep -q 'postgres' "$MOUNTED/alpha/docker-compose.yml" \
    && bad "the compose file still describes the detached service" || ok "compose was regenerated without the service (§9)"
  json_assert "$($CPROJ service list alpha --json)" 'd.services.length === 0' \
    && ok "service list is empty for alpha" || bad "service list still shows the detached service"
  json_assert "$($CPROJ status beta --json)" "d.projects[0].services[0].host_port === $PORT_B" \
    && ok "beta is untouched and keeps $PORT_B" || bad "removing alpha's service disturbed beta"

  $CPROJ down beta >/dev/null
fi

# ── 7. The freed port is reused ───────────────────────────────────────────────
head "7. The freed port is reused by the next add"

if [ "$DOCKER_OK" != "1" ]; then
  # Offline equivalent of section 6: detach so there is a freed port to reuse.
  REMOVED="$($CPROJ service remove alpha postgres --json)" || bad "service remove exited non-zero"
  schema_assert service-remove "$REMOVED" && ok "service remove --json validates against service-remove.schema.json" || bad "service remove output does not match its schema"
  json_assert "$REMOVED" "d.removed.host_port === $PORT_A && d.removed.volume === 'alpha_pgdata'" \
    && ok "it reports the released port and the kept volume" || bad "service remove reported the wrong outcome"
fi

$CPROJ new epsilon --archetype web >/dev/null
REUSE="$($CPROJ service add epsilon postgres --json)"
json_assert "$REUSE" "d.added.host_port === $PORT_A" \
  && ok "the next add reuses the freed port $PORT_A (§5)" || bad "the freed port was not reused (got $(json_value "$REUSE" 'd.added.host_port'), expected $PORT_A)"
json_assert "$($CPROJ service list beta --json)" "d.services[0].host_port === $PORT_B" \
  && ok "and beta's port was never a candidate — it is still assigned" || bad "an assigned port was handed out twice"

# ── 8. Renderers stay separate (§2) ───────────────────────────────────────────
head "8. Renderers stay separate (§2)"

HUMAN="$($CPROJ service list beta)"
if node -e "JSON.parse(process.argv[1])" "$HUMAN" 2>/dev/null; then
  bad "human service list output is JSON — the renderers are not separate"
else
  ok "human output is not JSON"
fi

# ── 9. Suites, typecheck, and the earlier phases ──────────────────────────────
head "9. Test suites, typecheck, and earlier done-checks"

if npm test >/dev/null 2>&1; then ok "npm test"; else bad "npm test"; fi
if npm run typecheck >/dev/null 2>&1; then ok "npm run typecheck"; else bad "npm run typecheck"; fi
for phase in 0 1 2; do
  if bash "test/phase${phase}-done-check.sh" >/dev/null 2>&1; then
    ok "test/phase${phase}-done-check.sh still passes"
  else
    bad "test/phase${phase}-done-check.sh regressed"
  fi
done

# ── Summary ───────────────────────────────────────────────────────────────────
printf '\n\033[1mPhase 3: %d passed, %d failed\033[0m\n' "$pass" "$fail"
[ "$fail" -eq 0 ] || exit 1
printf '\033[32mDone-check passed.\033[0m\n'
