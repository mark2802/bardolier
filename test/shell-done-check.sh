#!/usr/bin/env bash
# `bardolier shell`: the argv the CLI resolves, `--root`, `--print`, and the
# app-facing shape the menu runs (app-spec.md §7).
#
#   bash test/shell-done-check.sh
#   BARDOLIER_SKIP_DOCKER=1 …    offline assertions only
#   VERBOSE=1 …                  print every passing line
set -uo pipefail

source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
sandbox

track bardolier-alpha bardolier-beta
track_volume bardolier-alpha-home bardolier-beta-home

# ── 1. new → up → shell/--root/--print, plain shell unchanged ─────────────────
head "1. \`shell --root\` swaps to \`docker exec -u root\`; plain \`shell\` is untouched"

$BARDOLIER new alpha --archetype web >/dev/null

DOCKER_OK=0
if [ "${BARDOLIER_SKIP_DOCKER:-0}" = "1" ]; then
  skip "BARDOLIER_SKIP_DOCKER=1 — skipping the Docker half"
elif ! docker version --format '{{.Server.Version}}' >/dev/null 2>&1; then
  skip "no Docker daemon — skipping the Docker half"
else
  DOCKER_OK=1
fi

if [ "$DOCKER_OK" = "1" ]; then
  docker rm -f bardolier-alpha >/dev/null 2>&1 || true
  docker volume rm -f bardolier-alpha-home >/dev/null 2>&1 || true

  if ! docker image inspect bardolier-web:latest >/dev/null 2>&1; then
    printf '    building bardolier-web (first run only, this takes a few minutes)…\n'
    $BARDOLIER build --archetype web >/dev/null 2>&1 || bad "bardolier build failed"
  fi

  $BARDOLIER up alpha --json >/dev/null || bad "up alpha exited non-zero"

  PLAIN="$($BARDOLIER shell alpha --json)" || bad "shell exited non-zero"
  schema_assert shell "$PLAIN" && ok "plain shell --json still validates against shell.schema.json" || bad "plain shell output does not match its schema"
  json_assert "$PLAIN" "JSON.stringify(d.exec) === JSON.stringify(['docker','exec','-it','bardolier-alpha','bash'])" \
    && ok "plain shell is byte-identical to today's output" || bad "plain shell's exec argv changed"

  ROOT="$($BARDOLIER shell alpha --root --json)" || bad "shell --root exited non-zero"
  schema_assert shell "$ROOT" && ok "shell --root --json validates against the same shell.schema.json (no bump)" || bad "shell --root output does not match its schema"
  json_assert "$ROOT" "JSON.stringify(d.exec) === JSON.stringify(['docker','exec','-u','root','-it','bardolier-alpha','bash'])" \
    && ok "shell --root's exec has -u root ahead of -it" || bad "shell --root's exec argv is wrong"

  ROOT_PRINT="$($BARDOLIER shell alpha --root --print)"
  [ "$ROOT_PRINT" = "docker exec -u root -it bardolier-alpha bash" ] \
    && ok "shell --root --print prints the same command" || bad "shell --root --print printed '$ROOT_PRINT'"

  # Prove -u root actually lands as root, not just named as such.
  WHOAMI="$(docker exec -u root bardolier-alpha whoami 2>/dev/null | tr -d '\r')"
  [ "$WHOAMI" = "root" ] \
    && ok "the named invocation really does land as root" || bad "docker exec -u root did not land as root (got '$WHOAMI')"

  $BARDOLIER down alpha >/dev/null || bad "down alpha exited non-zero"
  STOPPED_ROOT="$($BARDOLIER shell alpha --root --json 2>/dev/null || true)"
  json_assert "$STOPPED_ROOT" 'd.error && d.error.code === "PROJECT_STOPPED"' \
    && ok "a stopped project still fails PROJECT_STOPPED with --root" || bad "shell --root resolved a stopped project"
fi

# ── 2. Shell-open: the CLI resolves, the app runs (app-spec.md §7) ────────────
head "2. Shell-open resolves to argv the app can run (§7)"

$BARDOLIER new beta --archetype web >/dev/null || bad "new exited non-zero"

if OUT="$($BARDOLIER shell beta --json 2>&1)"; then
  bad "shell answered for a stopped project"
else
  if json_assert "$OUT" "d.error.code === 'PROJECT_STOPPED'"; then
    ok "a stopped project is PROJECT_STOPPED — the app relays it, never auto-starts"
  else
    bad "shell failed with the wrong code: $OUT"
  fi
fi

# The running case needs a container; the contract tests cover it against a
# stub. Here we only assert the shape the app depends on is documented.
if [ -f cli/schema/shell.schema.json ] && node -e "
  const s = require('./cli/schema/shell.schema.json')
  process.exit(s.required.includes('exec') && s.properties.exec.type === 'array' ? 0 : 1)
"; then
  ok "shell's contract is argv, so the app quotes once and spawns the terminal, not docker"
else
  bad "shell.schema.json no longer promises an argv array"
fi

# ── Summary ───────────────────────────────────────────────────────────────────
summary "Shell"
