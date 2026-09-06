#!/usr/bin/env bash
# Named extra ports (§5.1): declared on any archetype, published beside
# `app_port`, stable across a restart, released on remove.
#
#   bash test/ports-done-check.sh
#   BARDOLIER_SKIP_DOCKER=1 …    offline assertions only
#   VERBOSE=1 …                  print every passing line
set -uo pipefail

source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
sandbox

track bardolier-alpha
track_volume bardolier-alpha-home

manifest_extra_port() { # manifest_extra_port <project> <name>
  manifest_field "$1" "m.extra_ports?.['$2']?.host_port ?? ''"
}

# ── 1. library — a portless archetype gets one ────────────────────────────────
head "1. \`port add\` on \`library\`: an archetype that otherwise publishes nothing (§5.1)"

$BARDOLIER new mylib --archetype library >/dev/null

ADDED="$($BARDOLIER port add mylib notebook --container-port 8888 --json)" || bad "port add exited non-zero"
schema_assert port-add "$ADDED" && ok "port add --json validates against port-add.schema.json" || bad "port add output does not match its schema"
json_assert "$ADDED" "d.added.name === 'notebook' && d.added.host_port === 8888 && d.added.url === 'http://localhost:8888'" \
  && ok "the port is named, defaults to the container port, and carries a ready-to-open URL" || bad "port add reported the wrong shape"

[ "$(manifest_extra_port mylib notebook)" = "8888" ] \
  && ok "the port is persisted in project.yml (§4.2, §5.1)" || bad "project.yml does not record the declared port"
grep -q '8888:8888' "$MOUNTED/mylib/docker-compose.yml" \
  && ok "compose publishes it even though \`library\` has no app_port (§9)" || bad "the compose file does not publish the port"

LIST="$($BARDOLIER port list mylib --json)"
schema_assert port-list "$LIST" && ok "port list --json validates against port-list.schema.json" || bad "port list output does not match its schema"
json_assert "$LIST" "d.extra_ports.length === 1 && d.extra_ports[0].name === 'notebook'" \
  && ok "port list resolves the declared port" || bad "port list is wrong"

STATUS="$($BARDOLIER status mylib --json)"
schema_assert status "$STATUS" && ok "status still matches the §7 schema with an extra port declared" || bad "status broke its schema"
json_assert "$STATUS" "d.projects[0].extra_ports[0].host_port === 8888" \
  && ok "status reports the declared port" || bad "status does not report the port"

# ── 2. web — a second port alongside app_port ─────────────────────────────────
head "2. \`port add\` on \`web\`: a second port beside app_port (§5.1)"

$BARDOLIER new myapp --archetype web >/dev/null
# `new` assigns app_port immediately for an archetype that has one (§9) — no
# `up` needed to learn it, which keeps this section Docker-free.
APP_PORT="$(json_value "$($BARDOLIER status myapp --json)" 'd.projects[0].app_port')"

METRO="$($BARDOLIER port add myapp metro --container-port 8081 --json)" || bad "port add exited non-zero"
METRO_PORT="$(json_value "$METRO" 'd.added.host_port')"
[ "$METRO_PORT" != "$APP_PORT" ] \
  && ok "the extra port ($METRO_PORT) is distinct from app_port ($APP_PORT)" || bad "the extra port collided with app_port"

grep -q "$APP_PORT:3000" "$MOUNTED/myapp/docker-compose.yml" \
  && ok "app_port is still published" || bad "app_port disappeared from compose"
grep -q "$METRO_PORT:8081" "$MOUNTED/myapp/docker-compose.yml" \
  && ok "the extra port publishes alongside it" || bad "the extra port is missing from compose"

# ── 3. Error paths (§6) ────────────────────────────────────────────────────────
head "3. The §6 error paths"

DUP="$($BARDOLIER port add mylib notebook --container-port 9999 --json 2>/dev/null || true)"
json_assert "$DUP" 'd.error && d.error.code === "EXTRA_PORT_ATTACHED"' \
  && ok "declaring the same name twice is EXTRA_PORT_ATTACHED" || bad "a duplicate declaration was accepted"

NOTATT="$($BARDOLIER port remove mylib ghost --json 2>/dev/null || true)"
json_assert "$NOTATT" 'd.error && d.error.code === "EXTRA_PORT_NOT_ATTACHED"' \
  && ok "removing what is not declared is EXTRA_PORT_NOT_ATTACHED" || bad "a bogus removal was accepted"

GHOST="$($BARDOLIER port list ghost --json 2>/dev/null || true)"
json_assert "$GHOST" 'd.error && d.error.code === "PROJECT_NOT_FOUND"' \
  && ok "an unknown project is PROJECT_NOT_FOUND" || bad "port list resolved a project that does not exist"

BADPORT="$($BARDOLIER port add mylib bogus --container-port not-a-number --json 2>/dev/null || true)"
json_assert "$BADPORT" 'd.error && d.error.code === "INVALID_ARGUMENT"' \
  && ok "a non-numeric --container-port is INVALID_ARGUMENT" || bad "a bad --container-port was accepted"

# ── 4. The Docker half: up → connect → restart → port unchanged ───────────────
head "4. Both extra ports reachable from the host, stable across a restart"

DOCKER_OK=0
if [ "${BARDOLIER_SKIP_DOCKER:-0}" = "1" ]; then
  skip "BARDOLIER_SKIP_DOCKER=1 — skipping the Docker half"
elif ! docker version --format '{{.Server.Version}}' >/dev/null 2>&1; then
  skip "no Docker daemon — skipping the Docker half (the offline checks above still ran)"
else
  DOCKER_OK=1
fi

if [ "$DOCKER_OK" = "1" ]; then
  docker rm -f bardolier-mylib bardolier-myapp >/dev/null 2>&1 || true
  docker volume rm -f bardolier-mylib-home bardolier-myapp-home >/dev/null 2>&1 || true

  if ! docker image inspect bardolier-web:latest >/dev/null 2>&1; then
    printf '    building bardolier-web (first run only, this takes a few minutes)…\n'
    $BARDOLIER build --archetype web >/dev/null 2>&1 || bad "bardolier build failed"
  fi

  UP_LIB="$($BARDOLIER up mylib --json)" || bad "up mylib exited non-zero"
  json_assert "$UP_LIB" "d.state === 'running'" && ok "mylib (library) is running" || bad "mylib did not come up"
  tcp_connect 8888 && ok "a host client can connect to the notebook port on 8888" || bad "nothing is listening on 8888"

  UP_APP="$($BARDOLIER up myapp --json)" || bad "up myapp exited non-zero"
  json_assert "$UP_APP" "d.state === 'running'" && ok "myapp (web) is running" || bad "myapp did not come up"
  tcp_connect "$APP_PORT" && ok "the dev server is reachable on $APP_PORT" || bad "nothing is listening on $APP_PORT"
  tcp_connect "$METRO_PORT" && ok "the extra port is reachable on $METRO_PORT" || bad "nothing is listening on $METRO_PORT"

  RUNNING_ADD="$($BARDOLIER port add mylib second --container-port 9999 --json 2>/dev/null || true)"
  json_assert "$RUNNING_ADD" 'd.error && d.error.code === "PROJECT_RUNNING"' \
    && ok "port add on a running project is PROJECT_RUNNING" || bad "a running project accepted a port add"

  # Restart: the port must survive (§5.2, same rule as a service's).
  $BARDOLIER down mylib >/dev/null || bad "down mylib exited non-zero"
  RESTART="$($BARDOLIER up mylib --json)" || bad "restarting mylib exited non-zero"
  [ "$(manifest_extra_port mylib notebook)" = "8888" ] \
    && ok "the port is unchanged across a restart (§5.2)" || bad "the port moved on restart"
  tcp_connect 8888 && ok "the same port is reachable again after the restart" || bad "8888 is not listening after the restart"

  $BARDOLIER down mylib >/dev/null
  $BARDOLIER down myapp >/dev/null
fi

# ── 5. The freed port is reused, and delete releases it ───────────────────────
head "5. \`port remove\`/\`delete\` release the port for reuse"

REMOVED="$($BARDOLIER port remove mylib notebook --json)" || bad "port remove exited non-zero"
schema_assert port-remove "$REMOVED" && ok "port remove --json validates against port-remove.schema.json" || bad "port remove output does not match its schema"
json_assert "$REMOVED" "d.removed.host_port === 8888 && d.extra_ports.length === 0" \
  && ok "it reports the released port" || bad "port remove reported the wrong outcome"
[ -z "$(manifest_extra_port mylib notebook)" ] \
  && ok "the manifest no longer claims the port" || bad "the manifest still records the removed port"
grep -q '8888' "$MOUNTED/mylib/docker-compose.yml" \
  && bad "the compose file still describes the removed port" || ok "compose was regenerated without the port (§9)"

$BARDOLIER new zeta --archetype library >/dev/null
REUSE="$($BARDOLIER port add zeta notebook --container-port 8888 --json)"
json_assert "$REUSE" "d.added.host_port === 8888" \
  && ok "the next add reuses the freed port 8888 (§5)" || bad "the freed port was not reused"

DELETE="$($BARDOLIER delete zeta --force --json)" || bad "delete zeta exited non-zero"
json_assert "$DELETE" "d.released_ports.includes(8888)" \
  && ok "delete releases the project's extra ports too" || bad "delete did not report the extra port as released"

# ── Summary ───────────────────────────────────────────────────────────────────
summary "Ports"
