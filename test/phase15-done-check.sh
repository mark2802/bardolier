#!/usr/bin/env bash
# Phase 15 done-check — the rename: CLI, docs, artefact namespaces
# (docs/phases/15-rename-cli.md). The engine is now `bardolier` (alias `bdlr`);
# `cproj`/`claude-yard`/`CPROJ_`/`claude-{web,ios,and}` must be gone from the
# CLI side of the boundary. `app/` is excluded on purpose — the Swift rename is
# phase 16, and this file's own comments and docs/phases/{15,16} are excluded
# because they are text ABOUT the rename, not code the rename touches.
#
#   bash test/phase15-done-check.sh
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

# ── 1. The old name is gone from everything but app/ and the rename's own docs ─
head "1. old name absent outside app/ and docs/phases/{15,16}"

# Built from parts so this assertion doesn't trip on itself.
OLD_NAME="cp""roj"
OLD_YARD="claude-""yard"
OLD_ENV="CP""ROJ_"
OLD_WEB="claude-""web"
OLD_IOS="claude-""ios"
OLD_AND="claude-""and"

# These test files read the app's *actual* Swift source as text (structs,
# filenames, defaults keys) and must keep naming it correctly until the
# human's Xcode rename (phase 16's MANUAL prerequisite) moves
# app/claude-yard/claude-yard on disk — mirroring the app/ exclusion, not a
# missed rename. phase16-done-check.sh names the old strings on purpose, to
# check they're gone. .claude/settings.local.json's hit is an unrelated
# harness scratch-path.
HITS="$(grep -rlEi "${OLD_NAME}|${OLD_YARD}|${OLD_ENV}|${OLD_WEB}|${OLD_IOS}|${OLD_AND}" . \
  --include='*' -I 2>/dev/null \
  | grep -v '^\./node_modules/' \
  | grep -v '^\./\.git/' \
  | grep -v '^\./app/' \
  | grep -v '^\./\.claude/' \
  | grep -v '^\./docs/phases/15-rename-cli\.md$' \
  | grep -v '^\./docs/phases/16-rename-app\.md$' \
  | grep -v '^\./test/phase15-done-check\.sh$' \
  | grep -v '^\./test/phase16-done-check\.sh$' \
  | grep -v '^\./test/phase[5679]-done-check\.sh$' \
  | grep -v '^\./test/phase7\.test\.ts$' \
  | grep -v '^\./test/app-models\.test\.ts$' \
  || true)"

if [ -z "$HITS" ]; then
  ok "no leftover old name outside app/ and the rename's own docs"
else
  bad "old name still present:"
  printf '%s\n' "$HITS" | sed 's/^/      /'
fi

# ── 2. bardolier and its alias bdlr both work ──────────────────────────────────
head "2. bardolier --help and the bdlr alias"

$BARDOLIER --help >/dev/null && ok "bardolier --help" || bad "bardolier --help exited non-zero"

BDLR_BIN="cli/bin/bardolier.js"
node "$BDLR_BIN" --version >/dev/null && ok "the bdlr-aliased script runs" || bad "bardolier.js --version exited non-zero"
node -e "
  const pkg = JSON.parse(require('fs').readFileSync('cli/package.json', 'utf8'))
  process.exit(pkg.bin && pkg.bin.bdlr === './bin/bardolier.js' && pkg.bin.bardolier === './bin/bardolier.js' ? 0 : 1)
" && ok "cli/package.json declares both \`bardolier\` and \`bdlr\` pointing at the same script" \
  || bad "cli/package.json bin field is missing bardolier or bdlr"

STATUS="$($BARDOLIER status --json)"
node -e "JSON.parse(process.argv[1])" "$STATUS" >/dev/null 2>&1 \
  && ok "bardolier status --json prints valid JSON" || bad "status --json did not print valid JSON: $STATUS"

# ── 3. Full lifecycle, unchanged behaviour ─────────────────────────────────────
head "3. new → up → service add → status → down → delete"

TMP="$(mktemp -d)"
cleanup() {
  if [ "${DOCKER_OK:-0}" = "1" ]; then
    docker rm -f bardolier-rename bardolier-rename-postgres >/dev/null 2>&1 || true
    docker volume rm -f rename_pgdata bardolier-rename-home >/dev/null 2>&1 || true
  fi
  rm -rf "$TMP"
}
trap cleanup EXIT

ROOT="$TMP/local-root"
mkdir -p "$ROOT"

export BARDOLIER_CONFIG="$TMP/config.yml"
export BARDOLIER_SSD_ROOT="$ROOT"
export BARDOLIER_SSD_VOLUME="$ROOT"

json_assert() { # json_assert <json> <js body over `d`>
  node -e "
    const d = JSON.parse(process.argv[1])
    process.exit((${2}) ? 0 : 1)
  " "$1" 2>/dev/null
}

$BARDOLIER new rename --archetype web >/dev/null && ok "new" || bad "new exited non-zero"
# service add/remove require the project stopped (CLAUDE.md) — attach before up.
$BARDOLIER service add rename postgres >/dev/null && ok "service add" || bad "service add exited non-zero"

DOCKER_OK=0
if [ "${BARDOLIER_SKIP_DOCKER:-0}" = "1" ]; then
  skip "BARDOLIER_SKIP_DOCKER=1 — skipping the Docker half"
elif ! docker version --format '{{.Server.Version}}' >/dev/null 2>&1; then
  skip "no Docker daemon — skipping the Docker half"
else
  DOCKER_OK=1
  $BARDOLIER build --archetype web >/dev/null 2>&1 || bad "bardolier build --archetype web failed"
  $BARDOLIER up rename --no-shell >/dev/null && ok "up" || bad "up exited non-zero"

  STATUS="$($BARDOLIER status --json)"
  if json_assert "$STATUS" "d.projects[0]?.state === 'running' && d.projects[0]?.dev_container === 'bardolier-rename'"; then
    ok "status: running, dev_container named bardolier-rename"
  else
    bad "status did not report the renamed container: $STATUS"
  fi

  docker ps --format '{{.Names}}' | grep -qx 'bardolier-rename' \
    && ok "the running container is actually named bardolier-rename" \
    || bad "no container named bardolier-rename is running"

  $BARDOLIER down rename >/dev/null && ok "down" || bad "down exited non-zero"
fi

$BARDOLIER delete rename --force --purge >/dev/null && ok "delete" || bad "delete exited non-zero"

# ── Summary ────────────────────────────────────────────────────────────────────
printf '\n\033[1mPhase 15: %d passed, %d failed\033[0m\n' "$pass" "$fail"
[ "$fail" -eq 0 ] || exit 1
printf '\033[32mDone-check passed.\033[0m\n'
