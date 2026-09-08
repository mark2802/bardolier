#!/usr/bin/env bash
# Roots and the volume derived from one: a root on the internal disk is
# first-class, `eject` refuses it rather than half-doing it, and several roots
# are configured, listed, allocated across, and forgotten.
#
#   bash test/roots-done-check.sh
#   BARDOLIER_SKIP_DOCKER=1 …    offline assertions only
#   VERBOSE=1 …                  print every passing line
set -uo pipefail

source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
sandbox

ROOT="$MOUNTED"
ROOT_A="$TMP/root-a"
ROOT_B="$TMP/root-b"
mkdir -p "$ROOT_A" "$ROOT_B"

plant_manifest() { # plant_manifest <root> <name>
  mkdir -p "$1/$2"
  cat > "$1/$2/project.yml" <<MANIFEST
name: $2
archetype: web
base_image: bardolier-web
created: '2026-01-01T00:00:00.000Z'
MANIFEST
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

# ── 4. eject on a non-removable root: refused, naming a derived volume ────────
head "4. eject on the internal disk (§6)"

if OUT="$($BARDOLIER eject --json 2>&1)"; then
  bad "eject succeeded against a plain directory: $OUT"
elif json_assert "$OUT" "d.error?.code === 'EJECT_NOT_APPLICABLE' && typeof d.error?.message === 'string' && d.error.message.length > 0"; then
  ok "EJECT_NOT_APPLICABLE, naming a derived volume"
else
  bad "eject failed with the wrong code: $OUT"
fi

# ── 5. eject on an absent root: SSD_NOT_MOUNTED naming the root ───────────────
head "5. eject on an absent root (§6)"

if OUT="$(BARDOLIER_ROOT="$ROOT/claude-projects-gone" $BARDOLIER eject --json 2>&1)"; then
  bad "eject succeeded against a root that does not exist: $OUT"
elif json_assert "$OUT" "d.error?.code === 'SSD_NOT_MOUNTED' && d.error.message.includes('${ROOT}/claude-projects-gone')"; then
  ok "SSD_NOT_MOUNTED, naming the root"
else
  bad "eject failed with the wrong code, or did not name the root: $OUT"
fi

# ── 6. config get: no ssd_volume, ever ─────────────────────────────────────────
head "6. config get (§8)"

GET="$($BARDOLIER config get --json)"
if json_assert "$GET" "!('ssd_volume' in d.config)"; then
  ok "config get has no ssd_volume"
else
  bad "ssd_volume is still in config get: $GET"
fi

# ── 7. \$BDLR_SSD_VOLUME is a no-op, not a silent override ────────────────────
head "7. \$BDLR_SSD_VOLUME (§8)"

GET_WITH_ENV="$(BDLR_SSD_VOLUME=/somewhere/else $BARDOLIER config get --json)"
if json_assert "$GET_WITH_ENV" "!d.overrides.includes('BDLR_SSD_VOLUME')"; then
  ok "BDLR_SSD_VOLUME set is absent from overrides"
else
  bad "BDLR_SSD_VOLUME was reported as an override: $GET_WITH_ENV"
fi

# From here on the roots come from the config file the CLI writes, so the
# single-root env override has to be out of the way (§8), and `~` is this
# check's own — but only from here, since a bogus HOME hides `docker compose`
# from the docker CLI and the sections above need a real daemon.
unset BARDOLIER_ROOT
mkdir -p "$TMP/home"
export HOME="$TMP/home"

# ── 8. Two roots, configured through the CLI, not by hand ─────────────────────
head "8. \`root add\` (§8)"

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

# ── 9. Projects in both roots, listed with their root ─────────────────────────
head "9. \`new --root\`, \`status\`, \`list\` (§3, §6, §7)"

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

# ── 10. PROJECT_EXISTS is "in any root"; a hand-planted dup is PROJECT_AMBIGUOUS
head "10. Name collisions across roots (§6)"

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

# ── 11. \`eject\` with more than one root requires a name ───────────────────────
head "11. \`eject\` naming among several roots (§6)"

EJECT_NO_ARG="$($BARDOLIER eject --json 2>/dev/null || true)"
json_assert "$EJECT_NO_ARG" 'd.error && d.error.code === "INVALID_ARGUMENT" && d.error.message.includes("a, b")' \
  && ok "\`eject\` with two roots and no argument is INVALID_ARGUMENT, naming both" \
  || bad "eject did not ask which root: $EJECT_NO_ARG"

EJECT_ROOT_AND_ALL="$($BARDOLIER eject a --all --json 2>/dev/null || true)"
json_assert "$EJECT_ROOT_AND_ALL" 'd.error && d.error.code === "INVALID_ARGUMENT"' \
  && ok "\`eject <root> --all\` is INVALID_ARGUMENT — mutually exclusive" \
  || bad "eject accepted both a root and --all: $EJECT_ROOT_AND_ALL"

# Neither root here is removable (phase 22): `--all` finds zero candidates,
# same as the CLI would tell a single removable-less root.
EJECT_ALL="$($BARDOLIER eject --all --json 2>/dev/null || true)"
json_assert "$EJECT_ALL" 'd.error && d.error.code === "EJECT_NOT_APPLICABLE"' \
  && ok "\`eject --all\` with no removable root is EJECT_NOT_APPLICABLE" \
  || bad "eject --all did not refuse a non-removable pair of roots: $EJECT_ALL"

# ── 12. \`root remove\` forgets a location; it never touches it ────────────────
head "12. \`root remove\` (§8)"

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

# ── 13. An offline root degrades rather than refusing, once indexed (phase 27) ─
head "13. An indexed-but-unreadable root: allocation and the orphan scan degrade; \`status\` still doesn't refuse"

$BARDOLIER new delta --archetype web --root a --json >/dev/null || bad "new delta exited non-zero"
# root b still carries gamma's index from section 9 (write-through at `new`,
# confirmed there by section 9's own `status` call) — the remove/re-add in
# section 12 never touched it, and nothing has rescanned it since.
rm -rf "$ROOT_B"

SERVICE_ADD="$($BARDOLIER service add delta redis --json 2>/dev/null || true)"
json_assert "$SERVICE_ADD" 'd.error === undefined && d.degraded_roots?.[0]?.root === "b"' \
  && ok "\`service add\` in root a allocates against root b's index, and names it as degraded" \
  || bad "service add did not degrade with an indexed offline root: $SERVICE_ADD"

ORPHANED="$($BARDOLIER volumes orphaned --json 2>/dev/null || true)"
json_assert "$ORPHANED" 'd.error === undefined && d.unverified_roots === undefined' \
  && ok "\`volumes orphaned\` succeeds — root b's cache claims came from its index" \
  || bad "volumes orphaned did not degrade with an indexed offline root: $ORPHANED"

STATUS_PARTIAL="$($BARDOLIER status --json)" || bad "status exited non-zero with a root gone"
json_assert "$STATUS_PARTIAL" "
  d.projects.every((p) => p.root === 'a') &&
  d.projects.some((p) => p.name === 'alpha') &&
  d.projects.some((p) => p.name === 'delta') &&
  d.orphaned_volumes.length === 0 &&
  d.roots.find((r) => r.name === 'b')?.last_indexed !== null
" && ok "status still succeeds, lists only root a's projects, reports no orphans, and dates root b's index" \
  || bad "status did not degrade the way §7 promises: $STATUS_PARTIAL"

# ── 14. Write-through needs no scan; a never-indexed root stays strict on names
head "14. Write-through (§3a) needs no \`status\`; a never-indexed root still refuses a NAME (phase 27)"

ROOT_C="$TMP/root-c"
mkdir -p "$ROOT_C"
$BARDOLIER root add "$ROOT_C" --name c --json >/dev/null || bad "root add c exited non-zero"
$BARDOLIER new epsilon --archetype web --root c --json >/dev/null || bad "new epsilon exited non-zero"
rm -rf "$ROOT_C"

# No status/doctor/eject has run since epsilon was created — its index entry
# can only have come from write-through at `new` time.
DUP="$($BARDOLIER new epsilon --archetype web --root a --json 2>/dev/null || true)"
json_assert "$DUP" 'd.error && d.error.code === "PROJECT_EXISTS"' \
  && ok "a name taken only in root c's index is still PROJECT_EXISTS, sourced purely from write-through" \
  || bad "new did not see root c's write-through index: $DUP"

$BARDOLIER root remove c --json >/dev/null || bad "root remove c exited non-zero"
ROOT_D="$TMP/root-d" # never created, so never mounted and never indexed
$BARDOLIER root add "$ROOT_D" --name d --json >/dev/null || bad "root add d exited non-zero"

NEVER_INDEXED="$($BARDOLIER new zzz --archetype web --root a --json 2>/dev/null || true)"
json_assert "$NEVER_INDEXED" 'd.error && d.error.code === "ROOT_UNREADABLE"' \
  && ok "a root that is unreadable AND never indexed still refuses a name outright — the one strict case phase 27 keeps" \
  || bad "new did not refuse with a never-indexed root: $NEVER_INDEXED"

$BARDOLIER root remove d --json >/dev/null || bad "root remove d exited non-zero"

# ── Summary ───────────────────────────────────────────────────────────────────
summary "Roots"
