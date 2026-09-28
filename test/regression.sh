#!/usr/bin/env bash
# Every done-check, once, in order.
#
#   bash test/regression.sh                    # all of them
#   bash test/regression.sh services ports     # just these, in the order given
#   BARDOLIER_SKIP_DOCKER=1 …                  # offline assertions only
#   VERBOSE=1 …                                # every passing line, not just failures
#
# Each check is named for what it covers and is self-contained: it builds its
# own temp root and config, assumes nothing another check left behind, and can
# be run alone. Order here is cheapest first — the contract and the offline
# checks, then the ones that want a daemon, then `images`, which builds base
# images and runs Gradle under emulation and is minutes rather than seconds.
set -uo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO"

CHECKS=(contract status roots naming publishing app lifecycle layout services ports deps shell disk agent images)

if [ $# -gt 0 ]; then
  CHECKS=("$@")
fi

failed=()
for check in "${CHECKS[@]}"; do
  script="test/${check}-done-check.sh"
  if [ ! -f "$script" ]; then
    printf '\033[31mno such check: %s\033[0m\n' "$check" >&2
    exit 2
  fi
  printf '\n\033[1m══ %s ══\033[0m\n' "$check"
  if ! bash "$script"; then
    failed+=("$check")
  fi
done

printf '\n\033[1m══ regression ══\033[0m\n'
if [ "${#failed[@]}" -eq 0 ]; then
  printf '\033[32mall %d checks passed.\033[0m\n' "${#CHECKS[@]}"
else
  printf '\033[31m%d of %d failed: %s\033[0m\n' "${#failed[@]}" "${#CHECKS[@]}" "${failed[*]}"
  exit 1
fi
