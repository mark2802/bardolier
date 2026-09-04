#!/usr/bin/env bash
# Phase 14 done-check — root shell (docs/phases/14-root-shell.md): `docker exec
# -u root` named as `cproj shell --root`, one argv difference, no new checks
# beyond the ones `shell` already has. SSD is a temp dir (§8); the Docker half
# proves `up` → shell/--root/--print → down against a real container.
#
#   bash test/phase14-done-check.sh
#   CPROJ_SKIP_DOCKER=1 …    offline assertions only
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO"

CPROJ="node cli/bin/cproj.js"
pass=0
fail=0

ok()   { pass=$((pass + 1)); if [ -n "${VERBOSE:-}" ]; then printf '  \033[32m✓\033[0m %s\n' "$1"; fi; }
bad()  { printf '  \033[31m✗\033[0m %s\n' "$1"; fail=$((fail + 1)); }
skip() { printf '  \033[33m–\033[0m %s\n' "$1"; }
head() { printf '\n\033[1m%s\033[0m\n' "$1"; }

TMP="$(mktemp -d)"
cleanup() {
  if [ "${DOCKER_OK:-0}" = "1" ]; then
    docker rm -f cproj-alpha >/dev/null 2>&1 || true
    docker volume rm -f cproj-alpha-home >/dev/null 2>&1 || true
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

schema_assert() { # schema_assert <schema-name> <json>
  node --input-type=module -e "
    import { validate } from './cli/src/schema.ts'
    const { valid, errors } = validate(process.argv[1], JSON.parse(process.argv[2]))
    if (!valid) { console.error(errors.join('\n')); process.exit(1) }
  " "$1" "$2" 2>/dev/null
}

# ── 1. new → up → shell/--root/--print, plain shell unchanged ─────────────────
head "1. \`shell --root\` swaps to \`docker exec -u root\`; plain \`shell\` is untouched"

$CPROJ new alpha --archetype web >/dev/null

DOCKER_OK=0
if [ "${CPROJ_SKIP_DOCKER:-0}" = "1" ]; then
  skip "CPROJ_SKIP_DOCKER=1 — skipping the Docker half"
elif ! docker version --format '{{.Server.Version}}' >/dev/null 2>&1; then
  skip "no Docker daemon — skipping the Docker half"
else
  DOCKER_OK=1
fi

if [ "$DOCKER_OK" = "1" ]; then
  docker rm -f cproj-alpha >/dev/null 2>&1 || true
  docker volume rm -f cproj-alpha-home >/dev/null 2>&1 || true

  if ! docker image inspect claude-web:latest >/dev/null 2>&1; then
    printf '    building claude-web (first run only, this takes a few minutes)…\n'
    $CPROJ build --archetype web >/dev/null 2>&1 || bad "cproj build failed"
  fi

  $CPROJ up alpha --json >/dev/null || bad "up alpha exited non-zero"

  PLAIN="$($CPROJ shell alpha --json)" || bad "shell exited non-zero"
  schema_assert shell "$PLAIN" && ok "plain shell --json still validates against shell.schema.json" || bad "plain shell output does not match its schema"
  json_assert "$PLAIN" "JSON.stringify(d.exec) === JSON.stringify(['docker','exec','-it','cproj-alpha','bash'])" \
    && ok "plain shell is byte-identical to today's output" || bad "plain shell's exec argv changed"

  ROOT="$($CPROJ shell alpha --root --json)" || bad "shell --root exited non-zero"
  schema_assert shell "$ROOT" && ok "shell --root --json validates against the same shell.schema.json (no bump)" || bad "shell --root output does not match its schema"
  json_assert "$ROOT" "JSON.stringify(d.exec) === JSON.stringify(['docker','exec','-u','root','-it','cproj-alpha','bash'])" \
    && ok "shell --root's exec has -u root ahead of -it" || bad "shell --root's exec argv is wrong"

  ROOT_PRINT="$($CPROJ shell alpha --root --print)"
  [ "$ROOT_PRINT" = "docker exec -u root -it cproj-alpha bash" ] \
    && ok "shell --root --print prints the same command" || bad "shell --root --print printed '$ROOT_PRINT'"

  # Prove -u root actually lands as root, not just named as such.
  WHOAMI="$(docker exec -u root cproj-alpha whoami 2>/dev/null | tr -d '\r')"
  [ "$WHOAMI" = "root" ] \
    && ok "the named invocation really does land as root" || bad "docker exec -u root did not land as root (got '$WHOAMI')"

  $CPROJ down alpha >/dev/null || bad "down alpha exited non-zero"
  STOPPED_ROOT="$($CPROJ shell alpha --root --json 2>/dev/null || true)"
  json_assert "$STOPPED_ROOT" 'd.error && d.error.code === "PROJECT_STOPPED"' \
    && ok "a stopped project still fails PROJECT_STOPPED with --root" || bad "shell --root resolved a stopped project"
fi

# ── Summary ───────────────────────────────────────────────────────────────────
printf '\n\033[1mPhase 14: %d passed, %d failed\033[0m\n' "$pass" "$fail"
[ "$fail" -eq 0 ] || exit 1
printf '\033[32mDone-check passed.\033[0m\n'
