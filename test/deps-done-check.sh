#!/usr/bin/env bash
# Declared OS packages (§6, Deps): persisted in the manifest, resolved to a
# content-addressed derived image, present in the container `up` starts.
#
#   bash test/deps-done-check.sh
#   BARDOLIER_SKIP_DOCKER=1 …    offline assertions only
#   VERBOSE=1 …                  print every passing line
set -uo pipefail

source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
sandbox

track bardolier-alpha
track_volume bardolier-alpha-home

manifest_packages() { # manifest_packages <project>
  manifest_field "$1" "(m.extra_packages ?? []).join(',')"
}

# ── 1. deps add — declared, persisted, compose selects the derived image ──────
head "1. \`deps add\` declares a package and compose selects the derived image (§4.2, §9)"

$BARDOLIER new myapp --archetype web >/dev/null

ADDED="$($BARDOLIER deps add myapp figlet --json)" || bad "deps add exited non-zero"
schema_assert deps-add "$ADDED" && ok "deps add --json validates against deps-add.schema.json" || bad "deps add output does not match its schema"
json_assert "$ADDED" "d.added[0] === 'figlet' && d.extra_packages[0] === 'figlet'" \
  && ok "the package is declared and echoed back" || bad "deps add reported the wrong shape"
IMAGE="$(json_value "$ADDED" 'd.image')"
[[ "$IMAGE" == bardolier-deps-bardolier-web:* ]] \
  && ok "the resolved image is content-addressed ($IMAGE)" || bad "the resolved image tag is wrong: $IMAGE"

[ "$(manifest_packages myapp)" = "figlet" ] \
  && ok "the package is persisted in project.yml (§4.2)" || bad "project.yml does not record the declared package"
grep -q "image: $IMAGE" "$MOUNTED/myapp/docker-compose.yml" \
  && ok "compose selects the derived image (§9)" || bad "the compose file does not reference the derived image"

LIST="$($BARDOLIER deps list myapp --json)"
schema_assert deps-list "$LIST" && ok "deps list --json validates against deps-list.schema.json" || bad "deps list output does not match its schema"
json_assert "$LIST" "d.extra_packages.length === 1 && d.image === '$IMAGE'" \
  && ok "deps list resolves the declared package and image" || bad "deps list is wrong"

# ── 2. Two projects, same base image + packages → same tag ────────────────────
head "2. Content addressing: two projects, same base image and packages, share one tag"

$BARDOLIER new sibling --archetype web >/dev/null
SIBLING_ADD="$($BARDOLIER deps add sibling figlet --json)"
SIBLING_IMAGE="$(json_value "$SIBLING_ADD" 'd.image')"
[ "$SIBLING_IMAGE" = "$IMAGE" ] \
  && ok "the second project resolves to the identical image tag" || bad "the same base image and packages produced different tags"
$BARDOLIER delete sibling --force >/dev/null

# ── 3. Error paths (§6) ────────────────────────────────────────────────────────
head "3. The §6 error paths"

DUP="$($BARDOLIER deps add myapp figlet --json 2>/dev/null || true)"
json_assert "$DUP" 'd.error && d.error.code === "PACKAGE_ATTACHED"' \
  && ok "declaring the same package twice is PACKAGE_ATTACHED" || bad "a duplicate declaration was accepted"

NOTATT="$($BARDOLIER deps remove myapp ghost-pkg --json 2>/dev/null || true)"
json_assert "$NOTATT" 'd.error && d.error.code === "PACKAGE_NOT_ATTACHED"' \
  && ok "removing what is not declared is PACKAGE_NOT_ATTACHED" || bad "a bogus removal was accepted"

GHOST="$($BARDOLIER deps list ghost --json 2>/dev/null || true)"
json_assert "$GHOST" 'd.error && d.error.code === "PROJECT_NOT_FOUND"' \
  && ok "an unknown project is PROJECT_NOT_FOUND" || bad "deps list resolved a project that does not exist"

BADNAME="$($BARDOLIER deps add myapp 'Not A Package' --json 2>/dev/null || true)"
json_assert "$BADNAME" 'd.error && d.error.code === "INVALID_ARGUMENT"' \
  && ok "an unusable package name is INVALID_ARGUMENT" || bad "a bad package name was accepted"

# ── 4. The Docker half: up builds the derived image, package present ─────────
head "4. \`up\` builds the derived image; the running container has the package"

DOCKER_OK=0
if [ "${BARDOLIER_SKIP_DOCKER:-0}" = "1" ]; then
  skip "BARDOLIER_SKIP_DOCKER=1 — skipping the Docker half"
elif ! docker version --format '{{.Server.Version}}' >/dev/null 2>&1; then
  skip "no Docker daemon — skipping the Docker half (the offline checks above still ran)"
else
  DOCKER_OK=1
fi

if [ "$DOCKER_OK" = "1" ]; then
  docker rm -f bardolier-myapp >/dev/null 2>&1 || true
  docker volume rm -f bardolier-myapp-home >/dev/null 2>&1 || true

  if ! docker image inspect bardolier-web:latest >/dev/null 2>&1; then
    printf '    building bardolier-web (first run only, this takes a few minutes)…\n'
    $BARDOLIER build --archetype web >/dev/null 2>&1 || bad "bardolier build failed"
  fi

  UP="$($BARDOLIER up myapp --json)" || bad "up myapp exited non-zero"
  json_assert "$UP" "d.state === 'running'" && ok "myapp is running" || bad "myapp did not come up"

  docker exec bardolier-myapp dpkg -s figlet >/dev/null 2>&1 \
    && ok "the declared package is installed in the running container" || bad "figlet is not installed"

  RUNNING_ADD="$($BARDOLIER deps add myapp second-pkg --json 2>/dev/null || true)"
  json_assert "$RUNNING_ADD" 'd.error && d.error.code === "PROJECT_RUNNING"' \
    && ok "deps add on a running project is PROJECT_RUNNING" || bad "a running project accepted a deps add"

  # Restart: no root at runtime, the package must simply still be there —
  # Docker's own build cache is what makes the repeat `up` cheap (no
  # apt-get re-run), not a re-install.
  $BARDOLIER down myapp >/dev/null || bad "down myapp exited non-zero"
  $BARDOLIER up myapp --json >/dev/null || bad "restarting myapp exited non-zero"
  docker exec bardolier-myapp dpkg -s figlet >/dev/null 2>&1 \
    && ok "the package survives a down/up cycle" || bad "figlet is missing after the restart"

  # deps remove, then up: reverts to the plain base image.
  $BARDOLIER down myapp >/dev/null
  $BARDOLIER deps remove myapp figlet >/dev/null || bad "deps remove exited non-zero"
  $BARDOLIER up myapp --json >/dev/null || bad "up after deps remove exited non-zero"
  grep -q 'image: bardolier-web:latest' "$MOUNTED/myapp/docker-compose.yml" \
    && ok "compose reverted to the plain base image" || bad "compose still references a derived image"
  docker exec bardolier-myapp dpkg -s figlet >/dev/null 2>&1 \
    && bad "figlet is still installed after deps remove" || ok "the plain base image (no figlet) is what's actually running"

  $BARDOLIER down myapp >/dev/null
fi

# ── Summary ───────────────────────────────────────────────────────────────────
summary "Deps"
