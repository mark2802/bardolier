# The scaffolding every done-check shares.
#
#   source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
#   sandbox                     # a temp root and its own config; nothing of the user's
#   head "1. …" ; ok/bad/skip   # sections and their assertions
#   summary "Services"          # counts, exit status
#
# Each check is named for what it covers, runs alone, and assumes nothing about
# what ran before it. VERBOSE=1 prints every passing line, not just failures.

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO"

BARDOLIER="node cli/bin/bardolier.js"
pass=0
fail=0
manual=0

ok()   { pass=$((pass + 1)); if [ -n "${VERBOSE:-}" ]; then printf '  \033[32m✓\033[0m %s\n' "$1"; fi; }
bad()  { printf '  \033[31m✗\033[0m %s\n' "$1"; fail=$((fail + 1)); }
skip() { printf '  \033[33m–\033[0m %s\n' "$1"; }
todo() { printf '  \033[33m⚠\033[0m %s\n' "$1"; manual=$((manual + 1)); }
head() { printf '\n\033[1m%s\033[0m\n' "$1"; }

# Docker leftovers this check is responsible for, removed however it exits.
CONTAINERS=()
VOLUMES=()
track() { CONTAINERS+=("$@"); }
track_volume() { VOLUMES+=("$@"); }

sandbox() { # a root under a temp dir, with its own config file (§8)
  TMP="$(cd "$(mktemp -d)" && pwd -P)"
  MOUNTED="$TMP/ssd/claude-projects"
  mkdir -p "$MOUNTED"
  export BARDOLIER_CONFIG="$TMP/config.yml"
  export BARDOLIER_ROOT="$MOUNTED"
  trap sandbox_cleanup EXIT
}

sandbox_cleanup() {
  if [ "${DOCKER_OK:-0}" = "1" ]; then
    if [ "${#CONTAINERS[@]}" -gt 0 ]; then docker rm -f "${CONTAINERS[@]}" >/dev/null 2>&1 || true; fi
    if [ "${#VOLUMES[@]}" -gt 0 ]; then docker volume rm -f "${VOLUMES[@]}" >/dev/null 2>&1 || true; fi
  fi
  if [ -n "${TMP:-}" ]; then rm -rf "$TMP"; fi
}

docker_ready() { # sets DOCKER_OK, says why when it is 0, and returns it
  if [ "${BARDOLIER_SKIP_DOCKER:-0}" = "1" ]; then
    skip "BARDOLIER_SKIP_DOCKER=1 — skipping the Docker half"
    DOCKER_OK=0
  elif ! docker version --format '{{.Server.Version}}' >/dev/null 2>&1; then
    skip "no Docker daemon — skipping the Docker half"
    DOCKER_OK=0
  else
    DOCKER_OK=1
  fi
  [ "$DOCKER_OK" = "1" ]
}

ensure_image() { # ensure_image <image> — build the base once, when it is missing
  if ! docker image inspect "$1:latest" >/dev/null 2>&1; then
    printf '    building %s (first run only, this takes a few minutes)…\n' "$1"
    $BARDOLIER build --archetype "${2:-web}" >/dev/null 2>&1 || bad "bardolier build failed"
  fi
}

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

manifest_field() { # manifest_field <project> <js expression over `m`> [root]
  node --input-type=module -e "
    import { readFileSync } from 'node:fs'
    import { parse } from 'yaml'
    const m = parse(readFileSync(process.argv[1], 'utf8'))
    process.stdout.write(String(${2}))
  " "${3:-$MOUNTED}/$1/project.yml" 2>/dev/null
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

summary() { # summary <name>
  printf '\n\033[1m%s: %d passed, %d failed' "$1" "$pass" "$fail"
  if [ "$manual" -gt 0 ]; then printf ', %d manual' "$manual"; fi
  printf '\033[0m\n'
  [ "$fail" -eq 0 ] || exit 1
  printf '\033[32mDone-check passed.\033[0m\n'
}
