#!/usr/bin/env bash
# The read-only core: `status`, `list` and `doctor` report an empty root, an
# absent one, and a plug/unplug, without ever mutating or failing.
#
#   bash test/status-done-check.sh
#   BARDOLIER_SKIP_DOCKER=1 …    offline assertions only
#   VERBOSE=1 …                  print every passing line
set -uo pipefail

source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
sandbox

ABSENT="$TMP/nowhere/claude-projects"

# ── 1. status on an empty SSD ─────────────────────────────────────────────────
head "1. \`status --json\` on an empty SSD"

STATUS="$(BARDOLIER_ROOT="$MOUNTED" $BARDOLIER status --json)" || bad "status exited non-zero"

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
# Phase 1 reported [] unconditionally; since Phase 4 this is derived from the
# manifests and Docker's volumes, so a machine with leftover bardolier volumes can
# legitimately list some. What Phase 1 pinned is the SHAPE, and that every entry
# is complete — not that the machine happens to be tidy.
json_assert "$STATUS" 'Array.isArray(d.orphaned_volumes)' \
  && ok "orphaned_volumes is an array" || bad "orphaned_volumes is not an array"
json_assert "$STATUS" 'd.orphaned_volumes.every(v => typeof v.name === "string" && typeof v.size_bytes === "number" && typeof v.size_human === "string" && "last_project" in v)' \
  && ok "every orphan carries name, size and attribution (§7)" || bad "an orphan entry is incomplete"
json_assert "$STATUS" 'd.ssd.mounted === true' \
  && ok "ssd.mounted is true for a readable root" || bad "ssd.mounted should be true"
json_assert "$STATUS" 'typeof d.docker.available === "boolean"' \
  && ok "docker.available is reported as a boolean" || bad "docker.available missing"

# ── 2. status never fails on an absent SSD ────────────────────────────────────
head "2. \`status --json\` with the SSD absent (reporting, not failing)"

if UNPLUGGED="$(BARDOLIER_ROOT="$ABSENT" $BARDOLIER status --json)"; then
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
LIST_ERR="$(BARDOLIER_ROOT="$ABSENT" $BARDOLIER list --json || true)"
json_assert "$LIST_ERR" 'd.error && d.error.code === "SSD_NOT_MOUNTED"' \
  && ok "list fails SSD_NOT_MOUNTED where status does not" || bad "list did not fail SSD_NOT_MOUNTED"

if BARDOLIER_ROOT="$MOUNTED" $BARDOLIER list --json >/dev/null; then
  ok "list succeeds on an empty mounted SSD"
else
  bad "list failed on an empty mounted SSD"
fi

# ── 3. doctor tracks plug/unplug ──────────────────────────────────────────────
head "3. \`doctor --json\` reports SSD mounted/absent"

DOCTOR_UP="$(BARDOLIER_ROOT="$MOUNTED" $BARDOLIER doctor --json)"
DOCTOR_DOWN="$(BARDOLIER_ROOT="$ABSENT" $BARDOLIER doctor --json)"

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
if BARDOLIER_ROOT="$ABSENT" $BARDOLIER doctor --json >/dev/null; then
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
BARDOLIER_ROOT="$MOUNTED" $BARDOLIER status --json >/dev/null
BARDOLIER_ROOT="$MOUNTED" $BARDOLIER doctor --json >/dev/null
BARDOLIER_ROOT="$MOUNTED" $BARDOLIER list --json >/dev/null
AFTER="$(find "$TMP/ssd" | sort)"
if [ "$BEFORE" = "$AFTER" ]; then
  ok "status/doctor/list left the SSD tree untouched"
else
  bad "the SSD tree changed:"$'\n'"$(diff <(echo "$BEFORE") <(echo "$AFTER") || true)"
fi

if [ ! -e "$BARDOLIER_CONFIG" ]; then
  ok "no config file was created behind the user's back"
else
  bad "a config file appeared at $BARDOLIER_CONFIG"
fi

# ── 5. Human and machine output stay separate (§2) ────────────────────────────
head "5. Renderers stay separate (§2)"

HUMAN="$(BARDOLIER_ROOT="$MOUNTED" $BARDOLIER status)"
if node -e "JSON.parse(process.argv[1])" "$HUMAN" 2>/dev/null; then
  bad "human status output is JSON — the renderers are not separate"
else
  ok "human status output is not JSON"
fi
grep -q 'SSD' <<<"$HUMAN" && ok "human status names the SSD state" || bad "human status is missing the SSD state"

BARDOLIER_ROOT="$MOUNTED" $BARDOLIER doctor | grep -q 'Service catalogue' \
  && ok "human doctor renders its findings" || bad "human doctor output is missing findings"

# ── Summary ───────────────────────────────────────────────────────────────────
summary "Status"
