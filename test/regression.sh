#!/usr/bin/env bash
# The ladder, walked ONCE, in order.
#
# Every phase check used to end by re-running all of its predecessors, and each
# of those did the same — exponential, so phase 0's containers came up dozens of
# times and a run took the better part of an hour for a minute of distinct work.
# The walk lives here instead: each phase's own sections, once, in order, with
# CPROJ_REGRESSION set — the flag that tells a phase check to skip its own
# ladder. Same coverage, linear cost.
#
#   bash test/regression.sh                 # every phase that has a check
#   bash test/regression.sh --through 4     # phases 0-4 only
#   VERBOSE=1 bash test/regression.sh       # print every passing assertion
#
# Phase 8's sections build images and run Gradle, so the full walk is minutes
# rather than seconds; --through 7 skips that. Phase 11 also rebuilds an image
# (claude-web), but it's a fast Node build, not the emulated Android one. Phase
# 13 builds a small derived image on top of it (one apt package) — also fast.
# Phase 14 is a one-argv-difference `docker exec`, no image work.
set -uo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO"

LAST=14
THROUGH="$LAST"

while [ $# -gt 0 ]; do
  case "$1" in
    --through)
      THROUGH="${2:-}"
      shift 2 || true
      ;;
    --through=*)
      THROUGH="${1#*=}"
      shift
      ;;
    *)
      printf 'usage: bash test/regression.sh [--through N]\n' >&2
      exit 2
      ;;
  esac
done

case "$THROUGH" in
  ''|*[!0-9]*)
    printf '--through takes a phase number (0-%d)\n' "$LAST" >&2
    exit 2
    ;;
esac

# The flag that stops the recursion coming back: a phase check that sees it
# knows the ladder below it is already being walked here.
export CPROJ_REGRESSION=1

# Each check builds its own hermetic world — a temp SSD, its own config file —
# and §8 says the environment BEATS that file. So a caller's CPROJ_* would
# silently override what a check just wrote and fail it for the wrong reason
# (`config set did not record the change`). The ladder therefore hands every
# phase a clean slate rather than whatever the shell above it happened to
# export.
CLEAN_ENV=(env -u CPROJ_CONFIG -u CPROJ_SSD_ROOT -u CPROJ_SSD_VOLUME)

pass=0
fail=0
LOGS="$(mktemp -d)"
trap 'rm -rf "$LOGS"' EXIT

printf '\033[1mRegression: phases 0-%s, each run once\033[0m\n\n' "$THROUGH"

for phase in $(seq 0 "$THROUGH"); do
  script="test/phase${phase}-done-check.sh"
  if [ ! -f "$script" ]; then
    printf '  \033[31m✗\033[0m %s is missing\n' "$script"
    fail=$((fail + 1))
    continue
  fi

  started="$(date +%s)"
  if "${CLEAN_ENV[@]}" bash "$script" >"$LOGS/phase${phase}.log" 2>&1; then
    printf '  \033[32m✓\033[0m %s (%ds)\n' "$script" "$(( $(date +%s) - started ))"
    pass=$((pass + 1))
  else
    printf '  \033[31m✗\033[0m %s (%ds)\n' "$script" "$(( $(date +%s) - started ))"
    # The failing lines, not just the phase number: reproducing one of these
    # costs minutes, so the run that already has the answer should say it.
    grep -m 8 '✗' "$LOGS/phase${phase}.log" | sed 's/^/      /'
    fail=$((fail + 1))
  fi
done

printf '\n\033[1mRegression: %d passed, %d failed\033[0m\n' "$pass" "$fail"
[ "$fail" -eq 0 ] || exit 1
