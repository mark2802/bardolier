#!/usr/bin/env bash
# Phase 17 done-check — one root, a derived volume (docs/phases/17-derived-volume.md).
# `ssd_volume` is gone as a config key; `eject`'s mount point comes from
# `containingVolume(ssd_root)`, a real `st_dev` walk.
#
# REAL: `bardolier doctor`/`bardolier eject`/`diskutil info`, exactly like phase 10 —
# safe because `removable()` is read-only, and a plain temp dir answers "not
# removable" for the right reason on any Mac.
# NOT covered here: the branch where the root IS on a removable volume, which
# needs a stubbed `removable()` — that's `test/phase17.test.ts`.
#
#   bash test/phase17-done-check.sh
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO"

BARDOLIER="node cli/bin/bardolier.js"
pass=0
fail=0

ok()   { pass=$((pass + 1)); if [ -n "${VERBOSE:-}" ]; then printf '  \033[32m✓\033[0m %s\n' "$1"; fi; }
bad()  { printf '  \033[31m✗\033[0m %s\n' "$1"; fail=$((fail + 1)); }
head() { printf '\n\033[1m%s\033[0m\n' "$1"; }

TMP="$(cd "$(mktemp -d)" && pwd -P)"
trap 'rm -rf "$TMP"' EXIT

ROOT="$TMP/local-root"
mkdir -p "$ROOT/claude-projects"

export BARDOLIER_CONFIG="$TMP/config.yml"
export BDLR_SSD_ROOT="$ROOT/claude-projects"

json_assert() { # json_assert <json> <js body over `d`>
  node -e "
    const d = JSON.parse(process.argv[1])
    process.exit((${2}) ? 0 : 1)
  " "$1" 2>/dev/null
}

# ── 1. eject on a non-removable root: refused, naming a derived volume ────────
head "1. eject on the internal disk (§6)"

if OUT="$($BARDOLIER eject --json 2>&1)"; then
  bad "eject succeeded against a plain directory: $OUT"
elif json_assert "$OUT" "d.error?.code === 'EJECT_NOT_APPLICABLE' && typeof d.error?.message === 'string' && d.error.message.length > 0"; then
  ok "EJECT_NOT_APPLICABLE, naming a derived volume"
else
  bad "eject failed with the wrong code: $OUT"
fi

# ── 2. eject on an absent root: SSD_NOT_MOUNTED naming the root ───────────────
head "2. eject on an absent root (§6)"

if OUT="$(BDLR_SSD_ROOT="$ROOT/claude-projects-gone" $BARDOLIER eject --json 2>&1)"; then
  bad "eject succeeded against a root that does not exist: $OUT"
elif json_assert "$OUT" "d.error?.code === 'SSD_NOT_MOUNTED' && d.error.message.includes('${ROOT}/claude-projects-gone')"; then
  ok "SSD_NOT_MOUNTED, naming the root"
else
  bad "eject failed with the wrong code, or did not name the root: $OUT"
fi

# ── 3. config get: no ssd_volume, ever ─────────────────────────────────────────
head "3. config get (§8)"

GET="$($BARDOLIER config get --json)"
if json_assert "$GET" "!('ssd_volume' in d.config)"; then
  ok "config get has no ssd_volume"
else
  bad "ssd_volume is still in config get: $GET"
fi

# ── 4. \$BDLR_SSD_VOLUME is a no-op, not a silent override ────────────────────
head "4. \$BDLR_SSD_VOLUME (§8)"

GET_WITH_ENV="$(BDLR_SSD_VOLUME=/somewhere/else $BARDOLIER config get --json)"
if json_assert "$GET_WITH_ENV" "!d.overrides.includes('BDLR_SSD_VOLUME')"; then
  ok "BDLR_SSD_VOLUME set is absent from overrides"
else
  bad "BDLR_SSD_VOLUME was reported as an override: $GET_WITH_ENV"
fi

# ── Summary ────────────────────────────────────────────────────────────────────
printf '\n\033[1mPhase 17: %d passed, %d failed\033[0m\n' "$pass" "$fail"
[ "$fail" -eq 0 ] || exit 1
printf '\033[32mDone-check passed.\033[0m\n'
