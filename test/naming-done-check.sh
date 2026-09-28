#!/usr/bin/env bash
# One name, everywhere: the old ones are gone from the tree, `bardolier` and its
# `bdlr` alias both work, and a project's whole lifecycle runs under the name.
#
#   bash test/naming-done-check.sh
#   BARDOLIER_SKIP_DOCKER=1 …    offline assertions only
#   VERBOSE=1 …                  print every passing line
set -uo pipefail

source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
sandbox

track bardolier-alpha
track_volume bardolier-alpha-home

# ── 1. The old name is gone from everything but app/ and the rename's own docs ─
head "1. old name absent outside app/ and docs/development/phases/{15,16}"

# Built from parts so this assertion doesn't trip on itself.
OLD_NAME="cp""roj"
OLD_YARD="claude-""yard"
OLD_ENV="CP""ROJ_"
OLD_WEB="claude-""web"
OLD_IOS="claude-""ios"
OLD_AND="claude-""and"

# Three kinds of legitimate hit, all excluded: this check and the app check
# name the old strings on purpose, to prove they are gone; the rename's own
# specs and the retrospective record the history; and .claude/settings.local.json
# carries an unrelated harness scratch-path.
HITS="$(grep -rlEi "${OLD_NAME}|${OLD_YARD}|${OLD_ENV}|${OLD_WEB}|${OLD_IOS}|${OLD_AND}" . \
  --include='*' -I 2>/dev/null \
  | grep -v '^\./node_modules/' \
  | grep -v '^\./\.git/' \
  | grep -v '^\./app/' \
  | grep -v '^\./\.claude/' \
  | grep -v '^\./docs/development/phases/15-rename-cli\.md$' \
  | grep -v '^\./docs/development/phases/16-rename-app\.md$' \
  | grep -v '^\./docs/development/retrospective\.md$' \
  | grep -v '^\./test/naming-done-check\.sh$' \
  | grep -v '^\./test/app-done-check\.sh$' \
  | grep -v '^\./test/app\.test\.ts$' \
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

# A throwaway config: this only checks that the command runs and prints valid
# JSON, and must not depend on whatever config.yml happens to exist on the
# machine running it (phase 18 changed the file's shape — `roots`, not `ssd_root`).
STATUS="$(BARDOLIER_CONFIG="$(mktemp -d)/config.yml" $BARDOLIER status --json)"
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
export BARDOLIER_ROOT="$ROOT"
export BDLR_SSD_VOLUME="$ROOT"

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

# ── 4. The old name is gone from every renameable file ─────────────────────────
head "4. old name absent, app/ included"

OLD_NAME="cp""roj"
OLD_YARD="claude-""yard"
OLD_ENV="CP""ROJ_"
OLD_UNDERSCORE="claude_""yard"

# The MANUAL Xcode rename is done (§0 above), so the old name should be gone
# everywhere except the historical phase specs and this script's own OLD_*
# definitions and instructional text.
HITS="$(grep -rlEi "${OLD_NAME}|${OLD_YARD}|${OLD_ENV}|${OLD_UNDERSCORE}" . \
  --include='*' -I 2>/dev/null \
  | grep -v '^\./node_modules/' \
  | grep -v '^\./\.git/' \
  | grep -v '^\./\.claude/' \
  | grep -v '^\./docs/development/phases/15-rename-cli\.md$' \
  | grep -v '^\./docs/development/phases/16-rename-app\.md$' \
  | grep -v '^\./docs/development/retrospective\.md$' \
  | grep -v '^\./test/naming-done-check\.sh$' \
  | grep -v '^\./test/app-done-check\.sh$' \
  || true)"

if [ -z "$HITS" ]; then
  ok "no leftover old name outside the Xcode project file and the paths that name the real (not yet renamed) directory"
else
  bad "old name still present:"
  printf '%s\n' "$HITS" | sed 's/^/      /'
fi

# ── Summary ───────────────────────────────────────────────────────────────────
summary "Naming"
