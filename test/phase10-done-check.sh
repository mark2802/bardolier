#!/usr/bin/env bash
# Phase 10 done-check — a local root (no SSD required). The lifecycle already
# didn't care where `ssd_root` lives; this proves it still doesn't, and that
# `doctor`/`eject` now answer honestly once `ssd_volume` isn't removable.
#
# REAL: `bardolier doctor`/`bardolier eject` run for real, `diskutil` included — safe,
# because `removable()` is read-only and a false answer is exactly what makes
# `eject` refuse before it would ever reach a container or `diskutil eject`.
# STOOD IN: `ssd_root` AND `ssd_volume` are the SAME plain temp dir — there is
# no separate mount point, because this mode has no SSD at all. `diskutil info`
# cannot resolve an ordinary directory to a disk, so it reports non-removable
# for the right reason on any Mac, no stubbing required.
#
#   bash test/phase10-done-check.sh
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

TMP="$(cd "$(mktemp -d)" && pwd -P)"
cleanup() {
  if [ "${DOCKER_OK:-0}" = "1" ]; then
    docker rm -f bardolier-local bardolier-local-postgres >/dev/null 2>&1 || true
    docker volume rm -f local_pgdata bardolier-local-home >/dev/null 2>&1 || true
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

# ── 1. The lifecycle behaves exactly as it does on the SSD ────────────────────
head "1. new → service add → up → status → down → delete, on a plain directory"

$BARDOLIER new local --archetype web --services postgres >/dev/null && ok "new, with a service attached" || bad "new exited non-zero"

DOCKER_OK=0
if [ "${BARDOLIER_SKIP_DOCKER:-0}" = "1" ]; then
  skip "BARDOLIER_SKIP_DOCKER=1 — skipping the Docker half (doctor/eject checks below still run)"
elif ! docker version --format '{{.Server.Version}}' >/dev/null 2>&1; then
  skip "no Docker daemon — skipping the Docker half (doctor/eject checks below still run)"
else
  DOCKER_OK=1
  $BARDOLIER up local --no-shell >/dev/null && ok "up" || bad "up exited non-zero"
  STATUS="$($BARDOLIER status --json)"
  if json_assert "$STATUS" "d.projects[0]?.state === 'running' && d.projects[0]?.services[0]?.host_port > 0"; then
    ok "status: running, with a host port — no different from a real SSD"
  else
    bad "status did not report the project running with a port: $STATUS"
  fi
  $BARDOLIER down local >/dev/null && ok "down" || bad "down exited non-zero"
fi

$BARDOLIER delete local --force --purge >/dev/null && ok "delete" || bad "delete exited non-zero"

# ── 2. doctor: a local root is fine, not a degraded SSD ───────────────────────
head "2. doctor (no \"plug in\" remedy for a directory that was never going to have one)"

DOCTOR="$($BARDOLIER doctor --json)"
if json_assert "$DOCTOR" "d.findings.find((f) => f.id === 'ssd')?.ok === true"; then
  ok "the ssd finding is ok:true"
else
  bad "doctor did not consider the local root ok: $DOCTOR"
fi
if json_assert "$DOCTOR" "!/plug in/i.test(d.findings.find((f) => f.id === 'ssd')?.detail ?? '')"; then
  ok "no \"plug in the SSD\" remedy"
else
  bad "doctor still told the user to plug in an SSD that was never there: $DOCTOR"
fi

# ── 3. eject: refused immediately, nothing touched ────────────────────────────
head "3. eject on a non-removable root (§6)"

if OUT="$($BARDOLIER eject --json 2>&1)"; then
  bad "eject succeeded against a plain directory: $OUT"
elif json_assert "$OUT" "d.error?.code === 'EJECT_NOT_APPLICABLE'"; then
  ok "EJECT_NOT_APPLICABLE, naming \`bardolier down-all\` instead of \"plug in the SSD\""
else
  bad "eject failed with the wrong code: $OUT"
fi

# ── Summary ────────────────────────────────────────────────────────────────────
printf '\n\033[1mPhase 10: %d passed, %d failed\033[0m\n' "$pass" "$fail"
[ "$fail" -eq 0 ] || exit 1
printf '\033[32mDone-check passed.\033[0m\n'
