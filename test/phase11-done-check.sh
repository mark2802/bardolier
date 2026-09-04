#!/usr/bin/env bash
# Phase 11 done-check — Python in the web image: `new` and `up` a web project
# on a temp SSD, then prove `uv` works in the dev container and its cache
# (wheels + managed Python installs) is a shared volume, not a per-project one.
#
# Needs a Docker daemon and the network; always rebuilds bandolier-web (fast — a
# Node image, unlike the emulated Android one phase8 avoids rebuilding).
#
#   bash test/phase11-done-check.sh
#   PHASE11_QUICK=1 …   skip the uv python install / offline-cache proof
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO"

BANDOLIER="node cli/bin/bandolier.js"
pass=0
fail=0

ok()   { pass=$((pass + 1)); if [ -n "${VERBOSE:-}" ]; then printf '  \033[32m✓\033[0m %s\n' "$1"; fi; }
bad()  { printf '  \033[31m✗\033[0m %s\n' "$1"; fail=$((fail + 1)); }
skip() { printf '  \033[33m–\033[0m %s\n' "$1"; }
section() { printf '\n\033[1m%s\033[0m\n' "$1"; }

TMP="$(cd "$(mktemp -d)" && pwd -P)"
VOLUME="$TMP/ssd"
MOUNTED="$VOLUME/claude-projects"
mkdir -p "$MOUNTED"

export BANDOLIER_CONFIG="$TMP/config.yml"
export BANDOLIER_SSD_VOLUME="$VOLUME"
export BANDOLIER_SSD_ROOT="$MOUNTED"

cleanup() {
  $BANDOLIER down-all --force >/dev/null 2>&1 || true
  docker volume rm -f bandolier-pybits-home bandolier-pybits2-home >/dev/null 2>&1 || true
  # The shared cache is the point of this phase — leave it for the next run
  # unless explicitly asked to prove it survives from nothing.
  rm -rf "$TMP"
}
trap cleanup EXIT

# ── 1. Fast checks ────────────────────────────────────────────────────────────
section "1. Unit tests and the §4.3 map"

if npm test >/dev/null 2>&1; then ok "npm test — including test/phase8.test.ts's uv cache assertions"; else bad "npm test"; fi
if npm run typecheck >/dev/null 2>&1; then ok "npm run typecheck"; else bad "npm run typecheck"; fi

if ! docker info >/dev/null 2>&1; then
  bad "the Docker daemon did not respond — this phase's check is about a real container"
  printf '\n\033[1mPhase 11: %d passed, %d failed\033[0m\n' "$pass" "$fail"
  exit 1
fi
ok "the Docker daemon responded"

# ── 2. Build bandolier-web fresh, so this Dockerfile is the one running ─────────
section "2. bandolier-web, rebuilt with uv"

printf '    building bandolier-web (fast — a Node image)\n'
if $BANDOLIER build --archetype web >"$TMP/build.log" 2>&1; then
  ok "bandolier-web:latest built from cli/images/bandolier-web/Dockerfile"
else
  bad "\`bandolier build --archetype web\` failed:"
  tail -8 "$TMP/build.log" | sed 's/^/      /'
fi

# ── 3. A web project, up, with uv inside ──────────────────────────────────────
section "3. A Python API alongside the React frontend, in one dev container"

$BANDOLIER new pybits --archetype web >/dev/null || bad "\`bandolier new --archetype web\` failed"
DIR="$MOUNTED/pybits"

if grep -q "bandolier-uv-cache:/cache/uv" "$DIR/docker-compose.yml" && grep -q "external: true" "$DIR/docker-compose.yml"; then
  ok "the compose file mounts the shared uv cache as an external volume (§4.3, §9)"
else
  bad "the web project's compose file does not mount bandolier-uv-cache as an external volume"
fi

if grep -qi "proxy" "$DIR/CLAUDE.md"; then
  ok "its seeded CLAUDE.md says how a second process is reached (proxy, not a second port)"
else
  bad "the seeded CLAUDE.md is missing the proxy-not-a-second-port note"
fi

if $BANDOLIER up pybits --no-shell >/dev/null 2>&1; then
  ok "bandolier up pybits"
else
  bad "bandolier up pybits failed"
fi

if docker volume inspect bandolier-uv-cache >/dev/null 2>&1; then
  ok "bandolier up created the shared uv cache volume"
  ROLE="$(docker volume inspect bandolier-uv-cache --format '{{index .Labels "bandolier.role"}}' 2>/dev/null)"
  if [ "$ROLE" = "cache" ]; then
    ok "labelled bandolier.role=cache, so the orphan scan knows it belongs to no project"
  else
    bad "the cache volume is labelled '$ROLE' — the volume scan would misattribute it"
  fi
else
  bad "bandolier up did not create bandolier-uv-cache"
fi

CONTAINER="$($BANDOLIER status pybits --json 2>/dev/null | node -e "
  let s = ''
  process.stdin.on('data', (c) => (s += c)).on('end', () => {
    const d = JSON.parse(s)
    process.stdout.write(d.projects[0]?.dev_container ?? '')
  })
")"
in_c() { docker exec "$CONTAINER" bash -lc "$1"; }

if [ -n "$CONTAINER" ]; then
  if UVV="$(in_c 'uv --version 2>&1')"; then
    ok "the container has uv: $UVV"
  else
    bad "no working uv in the web container"
  fi

  if [ "${PHASE11_QUICK:-0}" = "1" ]; then
    skip "PHASE11_QUICK=1 — skipped uv python install and the offline-cache proof"
  else
    printf '    uv python install 3.12 (first run downloads an interpreter)\n'
    if in_c 'uv python install 3.12 >/dev/null 2>&1 && uv run --python 3.12 python3 -c "print(2 + 2)"' \
        >"$TMP/uv-python.log" 2>&1 && grep -q '^4$' "$TMP/uv-python.log"; then
      ok "uv python install + uv run actually execute Python 3.12"
    else
      bad "uv python install/run failed:"
      tail -5 "$TMP/uv-python.log" | sed 's/^/      /'
    fi

    if in_c 'test -n "$(find /cache/uv/python -mindepth 1 -maxdepth 1 2>/dev/null)"'; then
      ok "the managed Python interpreter landed in the shared volume, not under /work"
    else
      bad "UV_PYTHON_INSTALL_DIR holds nothing — the interpreter is not where the volume is"
    fi

    if in_c 'cd /work && uv venv >/dev/null 2>&1 && uv pip install --python .venv six >/dev/null 2>&1'; then
      ok "a project venv installs a real package via uv"
    else
      bad "uv venv / uv pip install failed in the container"
    fi

    if in_c 'test -n "$(find /cache/uv -maxdepth 1 -name "*.lock" -o -maxdepth 2 -type d -name wheels 2>/dev/null)"' \
        || in_c 'du -sh /cache/uv 2>/dev/null | grep -qv "^0"'; then
      ok "the wheel cache is populated in the shared volume"
    else
      bad "/cache/uv looks empty after a real install"
    fi

    # The offline proof: a second, unrelated project reuses the warm cache.
    $BANDOLIER new pybits2 --archetype web >/dev/null || bad "second \`bandolier new\` failed"
    $BANDOLIER up pybits2 --no-shell >/dev/null 2>&1 || bad "bandolier up pybits2 failed"
    CONTAINER2="$($BANDOLIER status pybits2 --json 2>/dev/null | node -e "
      let s = ''
      process.stdin.on('data', (c) => (s += c)).on('end', () => {
        const d = JSON.parse(s)
        process.stdout.write(d.projects[0]?.dev_container ?? '')
      })
    ")"
    if [ -n "$CONTAINER2" ] && docker exec "$CONTAINER2" bash -lc \
        'cd /work && uv venv >/dev/null 2>&1 && uv pip install --python .venv --offline six >/dev/null 2>&1'; then
      ok "a second, unrelated project installs the same package --offline: the cache is shared"
    else
      bad "the second project could not install six --offline — the cache did not carry over"
    fi
    $BANDOLIER down pybits2 >/dev/null 2>&1 || true
    $BANDOLIER delete pybits2 --force >/dev/null 2>&1 || true
  fi
fi

$BANDOLIER down pybits >/dev/null 2>&1 || true

printf '\n\033[1mPhase 11: %d passed, %d failed\033[0m\n' "$pass" "$fail"
[ "$fail" -eq 0 ]
