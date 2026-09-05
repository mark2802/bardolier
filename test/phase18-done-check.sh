#!/usr/bin/env bash
# Phase 18 done-check — many roots (docs/phases/18-many-roots.md).
#
# Two temp roots stand in for "an internal-disk root and an SSD root at the
# same time". Both are plain directories (§8 supports that, phase 10) — real
# `diskutil`/Docker are not needed to prove any of this phase's guarantees.
#
#   bash test/phase18-done-check.sh
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO"

BARDOLIER="node cli/bin/bardolier.js"
pass=0
fail=0

ok()   { pass=$((pass + 1)); if [ -n "${VERBOSE:-}" ]; then printf '  \033[32m✓\033[0m %s\n' "$1"; fi; }
bad()  { printf '  \033[31m✗\033[0m %s\n' "$1"; fail=$((fail + 1)); }
head() { printf '\n\033[1m%s\033[0m\n' "$1"; }

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

# HOME is sandboxed too: `root add`'s first call materialises the built-in
# default (~/bardolier-projects) into the file, and that must not name the
# real user's home directory.
export HOME="$TMP/home"
mkdir -p "$HOME"
export BARDOLIER_CONFIG="$TMP/config.yml"

ROOT_A="$TMP/root-a"
ROOT_B="$TMP/root-b"
mkdir -p "$ROOT_A" "$ROOT_B"

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

plant_manifest() { # plant_manifest <root> <name>
  mkdir -p "$1/$2"
  cat > "$1/$2/project.yml" <<EOF
name: $2
archetype: web
base_image: bardolier-web
created: '2026-01-01T00:00:00.000Z'
EOF
}

# ── 1. Two roots, configured through the CLI, not by hand ─────────────────────
head "1. \`root add\` (§8)"

$BARDOLIER root add "$ROOT_A" --name a --json >/dev/null || bad "root add a exited non-zero"
# The default the first call materialised is not one of our two roots — drop
# it so "two roots" means exactly the two this check made.
DEFAULT_NAME="$(json_value "$($BARDOLIER root list --json)" "d.roots[0].name")"
$BARDOLIER root remove "$DEFAULT_NAME" --json >/dev/null || bad "root remove of the materialised default exited non-zero"
$BARDOLIER root add "$ROOT_B" --name b --json >/dev/null || bad "root add b exited non-zero"

LIST_ROOTS="$($BARDOLIER root list --json)"
json_assert "$LIST_ROOTS" "d.roots.length === 2 && d.roots[0].name === 'a' && d.roots[1].name === 'b'" \
  && ok "roots[0] is the default (a), roots[1] is b" || bad "root list is not [a, b]: $LIST_ROOTS"
json_assert "$LIST_ROOTS" "d.roots.every((r) => r.mounted === true)" \
  && ok "both roots report mounted: true" || bad "a configured root did not report mounted"

# ── 2. Projects in both roots, listed with their root ─────────────────────────
head "2. \`new --root\`, \`status\`, \`list\` (§3, §6, §7)"

NEW_A="$($BARDOLIER new alpha --archetype web --services postgres --root a --json)" || bad "new alpha exited non-zero"
NEW_B="$($BARDOLIER new gamma --archetype web --services postgres --root b --json)" || bad "new gamma exited non-zero"

PORT_A="$(json_value "$NEW_A" "d.services[0].host_port")"
PORT_B="$(json_value "$NEW_B" "d.services[0].host_port")"
[ "$PORT_A" != "$PORT_B" ] \
  && ok "a port allocated in root a ($PORT_A) is not handed out again in root b ($PORT_B)" \
  || bad "both roots' postgres landed on the same host port"

STATUS="$($BARDOLIER status --json)"
json_assert "$STATUS" "d.projects.find((p) => p.name === 'alpha')?.root === 'a' && d.projects.find((p) => p.name === 'gamma')?.root === 'b'" \
  && ok "status reports each project's root" || bad "status did not report the right root per project: $STATUS"
json_assert "$STATUS" "d.roots.length === 2 && d.roots.every((r) => r.mounted)" \
  && ok "status.roots lists both configured roots, mounted" || bad "status.roots is wrong: $STATUS"

LIST="$($BARDOLIER list --json)"
json_assert "$LIST" "d.projects.find((p) => p.name === 'alpha')?.root === 'a' && d.projects.find((p) => p.name === 'gamma')?.root === 'b'" \
  && ok "list reports each project's root" || bad "list did not report the right root per project: $LIST"

# ── 3. PROJECT_EXISTS is "in any root"; a hand-planted dup is PROJECT_AMBIGUOUS
head "3. Name collisions across roots (§6)"

DUP_EXISTS="$($BARDOLIER new alpha --archetype web --root b --json 2>/dev/null || true)"
json_assert "$DUP_EXISTS" 'd.error && d.error.code === "PROJECT_EXISTS"' \
  && ok "\`new alpha --root b\` fails PROJECT_EXISTS (alpha already lives in root a)" \
  || bad "new accepted a name that exists in the other root: $DUP_EXISTS"

plant_manifest "$ROOT_A" dup
plant_manifest "$ROOT_B" dup
AMBIGUOUS="$($BARDOLIER up dup --json 2>/dev/null || true)"
json_assert "$AMBIGUOUS" 'd.error && d.error.code === "PROJECT_AMBIGUOUS"' \
  && ok "a name planted in both roots by hand makes \`up\` fail PROJECT_AMBIGUOUS" \
  || bad "up did not refuse an ambiguous name: $AMBIGUOUS"

# ── 4. \`eject\` with more than one root requires a name ───────────────────────
head "4. \`eject\` naming among several roots (§6)"

EJECT_NO_ARG="$($BARDOLIER eject --json 2>/dev/null || true)"
json_assert "$EJECT_NO_ARG" 'd.error && d.error.code === "INVALID_ARGUMENT" && d.error.message.includes("a, b")' \
  && ok "\`eject\` with two roots and no argument is INVALID_ARGUMENT, naming both" \
  || bad "eject did not ask which root: $EJECT_NO_ARG"

# ── 5. \`root remove\` forgets a location; it never touches it ────────────────
head "5. \`root remove\` (§8)"

echo precious > "$ROOT_B/marker"
REMOVED="$($BARDOLIER root remove b --json)" || bad "root remove b exited non-zero"
json_assert "$REMOVED" "d.removed.name === 'b' && d.roots.length === 1 && d.roots[0].name === 'a'" \
  && ok "root remove reports what was forgotten and what remains" || bad "root remove reported the wrong shape: $REMOVED"
[ -f "$ROOT_B/marker" ] && [ -d "$ROOT_B/gamma" ] \
  && ok "the directory and its contents are untouched" || bad "root remove touched the filesystem"

# Only `a` is left — forgetting it too must not silently rematerialise the
# built-in default in its place (a "fake" root nobody asked for).
LAST="$($BARDOLIER root remove a --json 2>/dev/null || true)"
json_assert "$LAST" 'd.error && d.error.code === "INVALID_ARGUMENT"' \
  && ok "removing the only configured root is refused, not silently replaced" || bad "the last root was removed: $LAST"

# Re-register b for the final section, which needs two roots again.
$BARDOLIER root add "$ROOT_B" --name b --json >/dev/null || bad "re-adding root b exited non-zero"

# ── 6. A partial view refuses rather than under-reporting (§5, §6) ───────────
head "6. \`ROOT_UNREADABLE\`: allocation and the orphan scan refuse; \`status\` does not (phase 18's central guarantee)"

$BARDOLIER new delta --archetype web --root a --json >/dev/null || bad "new delta exited non-zero"
rm -rf "$ROOT_B"

SERVICE_ADD="$($BARDOLIER service add delta redis --json 2>/dev/null || true)"
json_assert "$SERVICE_ADD" 'd.error && d.error.code === "ROOT_UNREADABLE"' \
  && ok "\`service add\` in root a fails ROOT_UNREADABLE rather than allocating while root b is unreadable" \
  || bad "service add allocated a port despite an unreadable root: $SERVICE_ADD"

ORPHANED="$($BARDOLIER volumes orphaned --json 2>/dev/null || true)"
json_assert "$ORPHANED" 'd.error && d.error.code === "ROOT_UNREADABLE"' \
  && ok "\`volumes orphaned\` fails ROOT_UNREADABLE rather than reporting root b's volumes as orphans" \
  || bad "volumes orphaned did not refuse: $ORPHANED"

STATUS_PARTIAL="$($BARDOLIER status --json)" || bad "status exited non-zero with a root gone"
json_assert "$STATUS_PARTIAL" "
  d.projects.every((p) => p.root === 'a') &&
  d.projects.some((p) => p.name === 'alpha') &&
  d.projects.some((p) => p.name === 'delta') &&
  d.orphaned_volumes.length === 0
" && ok "status still succeeds, lists only root a's projects, and reports no orphans" \
  || bad "status did not degrade the way §7 promises: $STATUS_PARTIAL"

# ── Summary ────────────────────────────────────────────────────────────────────
printf '\n\033[1mPhase 18: %d passed, %d failed\033[0m\n' "$pass" "$fail"
[ "$fail" -eq 0 ] || exit 1
printf '\033[32mDone-check passed.\033[0m\n'
