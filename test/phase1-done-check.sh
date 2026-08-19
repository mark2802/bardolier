#!/usr/bin/env bash
# Phase 1 done-check — implementation-plan.md.
#
#   "on an empty SSD, `cproj status --json` returns valid JSON with empty
#    projects/orphaned_volumes; `cproj doctor --json` correctly reports SSD
#    mounted/absent as you plug/unplug."
#
# The plug/unplug half is driven with CPROJ_SSD_ROOT (§8) against a temp dir, so
# this runs unattended and with no SSD attached. Keep this script: per CLAUDE.md,
# each CLI phase's done-check becomes a regression check.
#
#   bash test/phase1-done-check.sh
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO"

CPROJ="node cli/bin/cproj.js"
pass=0
fail=0

ok()   { printf '  \033[32m✓\033[0m %s\n' "$1"; pass=$((pass + 1)); }
bad()  { printf '  \033[31m✗\033[0m %s\n' "$1"; fail=$((fail + 1)); }
head() { printf '\n\033[1m%s\033[0m\n' "$1"; }

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

# An empty SSD, and a path that is definitively not mounted.
MOUNTED="$TMP/ssd/claude-projects"
ABSENT="$TMP/nowhere/claude-projects"
mkdir -p "$MOUNTED"

# Isolate from any real config on this machine, so the check measures the CLI
# rather than the operator's setup.
export CPROJ_CONFIG="$TMP/config.yml"
export CPROJ_SSD_VOLUME="$TMP/ssd"

# jq-free assertions: node reads the JSON on stdin and exits non-zero on mismatch.
json_assert() { # json_assert <json> <js body over `d`>
  node -e "
    const d = JSON.parse(process.argv[1])
    const check = (${2})
    process.exit(check ? 0 : 1)
  " "$1" 2>/dev/null
}

# ── 1. status on an empty SSD ─────────────────────────────────────────────────
head "1. \`status --json\` on an empty SSD"

STATUS="$(CPROJ_SSD_ROOT="$MOUNTED" $CPROJ status --json)" || bad "status exited non-zero"

if node -e "JSON.parse(process.argv[1])" "$STATUS" 2>/dev/null; then
  ok "emits a single parseable JSON value"
else
  bad "output is not valid JSON: $STATUS"
fi

if node --input-type=module -e "
  import { validate } from './cli/src/schema.ts'
  const status = JSON.parse(process.argv[1])
  const { valid, errors } = validate('status', status)
  if (!valid) { console.error(errors.join('\n')); process.exit(1) }
" "$STATUS" 2>/dev/null; then
  ok "validates against status.schema.json (§7)"
else
  bad "status output does not match the §7 schema"
fi

json_assert "$STATUS" 'Array.isArray(d.projects) && d.projects.length === 0' \
  && ok "projects is an empty array" || bad "projects is not empty"
json_assert "$STATUS" 'Array.isArray(d.orphaned_volumes) && d.orphaned_volumes.length === 0' \
  && ok "orphaned_volumes is an empty array" || bad "orphaned_volumes is not empty"
json_assert "$STATUS" 'd.ssd.mounted === true' \
  && ok "ssd.mounted is true for a readable root" || bad "ssd.mounted should be true"
json_assert "$STATUS" 'typeof d.docker.available === "boolean"' \
  && ok "docker.available is reported as a boolean" || bad "docker.available missing"

# ── 2. status never fails on an absent SSD ────────────────────────────────────
head "2. \`status --json\` with the SSD absent (reporting, not failing)"

if UNPLUGGED="$(CPROJ_SSD_ROOT="$ABSENT" $CPROJ status --json)"; then
  ok "exits 0 with the SSD unplugged"
else
  bad "status exited non-zero with the SSD unplugged"
  UNPLUGGED='{}'
fi
json_assert "$UNPLUGGED" "d.ssd.mounted === false && d.ssd.root === '$ABSENT'" \
  && ok "reports ssd.mounted false and still names the root" || bad "ssd block is wrong when unplugged"
json_assert "$UNPLUGGED" 'd.projects.length === 0 && d.orphaned_volumes.length === 0' \
  && ok "arrays stay empty rather than absent" || bad "arrays missing when unplugged"

# `list`, by contrast, is specified to fail (§6).
LIST_ERR="$(CPROJ_SSD_ROOT="$ABSENT" $CPROJ list --json || true)"
json_assert "$LIST_ERR" 'd.error && d.error.code === "SSD_NOT_MOUNTED"' \
  && ok "list fails SSD_NOT_MOUNTED where status does not" || bad "list did not fail SSD_NOT_MOUNTED"

if CPROJ_SSD_ROOT="$MOUNTED" $CPROJ list --json >/dev/null; then
  ok "list succeeds on an empty mounted SSD"
else
  bad "list failed on an empty mounted SSD"
fi

# ── 3. doctor tracks plug/unplug ──────────────────────────────────────────────
head "3. \`doctor --json\` reports SSD mounted/absent"

DOCTOR_UP="$(CPROJ_SSD_ROOT="$MOUNTED" $CPROJ doctor --json)"
DOCTOR_DOWN="$(CPROJ_SSD_ROOT="$ABSENT" $CPROJ doctor --json)"

if node --input-type=module -e "
  import { validate } from './cli/src/schema.ts'
  for (const raw of [process.argv[1], process.argv[2]]) {
    const { valid, errors } = validate('doctor', JSON.parse(raw))
    if (!valid) { console.error(errors.join('\n')); process.exit(1) }
  }
" "$DOCTOR_UP" "$DOCTOR_DOWN" 2>/dev/null; then
  ok "both reports validate against doctor.schema.json"
else
  bad "doctor output does not match its schema"
fi

json_assert "$DOCTOR_UP" 'd.findings.find(f => f.id === "ssd").ok === true' \
  && ok "SSD present  → ssd finding ok" || bad "ssd finding should be ok when mounted"
json_assert "$DOCTOR_DOWN" 'd.findings.find(f => f.id === "ssd").ok === false' \
  && ok "SSD absent   → ssd finding not ok" || bad "ssd finding should fail when absent"
json_assert "$DOCTOR_DOWN" 'typeof d.findings.find(f => f.id === "ssd").remedy === "string"' \
  && ok "the failing finding carries a remedy" || bad "no remedy on the failing ssd finding"
json_assert "$DOCTOR_DOWN" 'd.ok === false' \
  && ok "top-level ok is false when a check fails" || bad "top-level ok should be false"

# Exit code: a failing CHECK is an answer, not a failure to answer (model/doctor.ts).
if CPROJ_SSD_ROOT="$ABSENT" $CPROJ doctor --json >/dev/null; then
  ok "doctor exits 0 even with failing findings"
else
  bad "doctor exited non-zero on failing findings"
fi

json_assert "$DOCTOR_UP" 'd.findings.find(f => f.id === "config").detail.includes("using defaults")' \
  && ok "runs with no config file, reporting defaults" || bad "config finding did not report defaults"
json_assert "$DOCTOR_UP" 'd.findings.find(f => f.id === "catalogue").ok === true' \
  && ok "falls back to the bundled catalogue" || bad "catalogue finding failed"

# ── 4. Read-only means read-only ──────────────────────────────────────────────
head "4. The read-only core mutates nothing"

BEFORE="$(find "$TMP/ssd" | sort)"
CPROJ_SSD_ROOT="$MOUNTED" $CPROJ status --json >/dev/null
CPROJ_SSD_ROOT="$MOUNTED" $CPROJ doctor --json >/dev/null
CPROJ_SSD_ROOT="$MOUNTED" $CPROJ list --json >/dev/null
AFTER="$(find "$TMP/ssd" | sort)"
if [ "$BEFORE" = "$AFTER" ]; then
  ok "status/doctor/list left the SSD tree untouched"
else
  bad "the SSD tree changed:"$'\n'"$(diff <(echo "$BEFORE") <(echo "$AFTER") || true)"
fi

if [ ! -e "$CPROJ_CONFIG" ]; then
  ok "no config file was created behind the user's back"
else
  bad "a config file appeared at $CPROJ_CONFIG"
fi

# ── 5. Human and machine output stay separate (§2) ────────────────────────────
head "5. Renderers stay separate (§2)"

HUMAN="$(CPROJ_SSD_ROOT="$MOUNTED" $CPROJ status)"
if node -e "JSON.parse(process.argv[1])" "$HUMAN" 2>/dev/null; then
  bad "human status output is JSON — the renderers are not separate"
else
  ok "human status output is not JSON"
fi
grep -q 'SSD' <<<"$HUMAN" && ok "human status names the SSD state" || bad "human status is missing the SSD state"

CPROJ_SSD_ROOT="$MOUNTED" $CPROJ doctor | grep -q 'Service catalogue' \
  && ok "human doctor renders its findings" || bad "human doctor output is missing findings"

# ── 6. Suites ─────────────────────────────────────────────────────────────────
head "6. Test suites and typecheck"

if npm test >/dev/null 2>&1; then ok "npm test"; else bad "npm test"; fi
if npm run typecheck >/dev/null 2>&1; then ok "npm run typecheck"; else bad "npm run typecheck"; fi
if bash test/phase0-done-check.sh >/dev/null 2>&1; then
  ok "test/phase0-done-check.sh still passes"
else
  bad "test/phase0-done-check.sh regressed"
fi

# ── Summary ───────────────────────────────────────────────────────────────────
printf '\n\033[1mPhase 1: %d passed, %d failed\033[0m\n' "$pass" "$fail"
[ "$fail" -eq 0 ] || exit 1
printf '\033[32mDone-check passed.\033[0m\n'
