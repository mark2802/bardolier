#!/usr/bin/env bash
# Phase 13 done-check — extra packages (docs/phases/13-extra-packages.md): OS
# packages a project's toolchain needs beyond its base image, built into a
# content-addressed derived image at `up` rather than baked into the shared
# base image or installed at runtime (no root there, `down` throws the
# writable layer away regardless). SSD is a temp dir (§8); the Docker half
# builds a small derived image (`figlet`, fast, not in the base image).
#
#   bash test/phase13-done-check.sh
#   CPROJ_SKIP_DOCKER=1 …    offline assertions only
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO"

CPROJ="node cli/bin/cproj.js"
pass=0
fail=0

ok()   { pass=$((pass + 1)); if [ -n "${VERBOSE:-}" ]; then printf '  \033[32m✓\033[0m %s\n' "$1"; fi; }
bad()  { printf '  \033[31m✗\033[0m %s\n' "$1"; fail=$((fail + 1)); }
skip() { printf '  \033[33m–\033[0m %s\n' "$1"; }
head() { printf '\n\033[1m%s\033[0m\n' "$1"; }

TMP="$(mktemp -d)"
cleanup() {
  if [ "${DOCKER_OK:-0}" = "1" ]; then
    docker rm -f cproj-myapp >/dev/null 2>&1 || true
    docker volume rm -f cproj-myapp-home >/dev/null 2>&1 || true
  fi
  rm -rf "$TMP"
}
trap cleanup EXIT

MOUNTED="$TMP/ssd/claude-projects"
mkdir -p "$MOUNTED"

export CPROJ_CONFIG="$TMP/config.yml"
export CPROJ_SSD_VOLUME="$TMP/ssd"
export CPROJ_SSD_ROOT="$MOUNTED"

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

schema_assert() { # schema_assert <schema-name> <json>
  node --input-type=module -e "
    import { validate } from './cli/src/schema.ts'
    const { valid, errors } = validate(process.argv[1], JSON.parse(process.argv[2]))
    if (!valid) { console.error(errors.join('\n')); process.exit(1) }
  " "$1" "$2" 2>/dev/null
}

manifest_packages() { # manifest_packages <project>
  node --input-type=module -e "
    import { readFileSync } from 'node:fs'
    import { parse } from 'yaml'
    const m = parse(readFileSync(process.argv[1], 'utf8'))
    process.stdout.write((m.extra_packages ?? []).join(','))
  " "$MOUNTED/$1/project.yml" 2>/dev/null
}

# ── 1. deps add — declared, persisted, compose selects the derived image ──────
head "1. \`deps add\` declares a package and compose selects the derived image (§4.2, §9)"

$CPROJ new myapp --archetype web >/dev/null

ADDED="$($CPROJ deps add myapp figlet --json)" || bad "deps add exited non-zero"
schema_assert deps-add "$ADDED" && ok "deps add --json validates against deps-add.schema.json" || bad "deps add output does not match its schema"
json_assert "$ADDED" "d.added[0] === 'figlet' && d.extra_packages[0] === 'figlet'" \
  && ok "the package is declared and echoed back" || bad "deps add reported the wrong shape"
IMAGE="$(json_value "$ADDED" 'd.image')"
[[ "$IMAGE" == cproj-deps-claude-web:* ]] \
  && ok "the resolved image is content-addressed ($IMAGE)" || bad "the resolved image tag is wrong: $IMAGE"

[ "$(manifest_packages myapp)" = "figlet" ] \
  && ok "the package is persisted in project.yml (§4.2)" || bad "project.yml does not record the declared package"
grep -q "image: $IMAGE" "$MOUNTED/myapp/docker-compose.yml" \
  && ok "compose selects the derived image (§9)" || bad "the compose file does not reference the derived image"

LIST="$($CPROJ deps list myapp --json)"
schema_assert deps-list "$LIST" && ok "deps list --json validates against deps-list.schema.json" || bad "deps list output does not match its schema"
json_assert "$LIST" "d.extra_packages.length === 1 && d.image === '$IMAGE'" \
  && ok "deps list resolves the declared package and image" || bad "deps list is wrong"

# ── 2. Two projects, same base image + packages → same tag ────────────────────
head "2. Content addressing: two projects, same base image and packages, share one tag"

$CPROJ new sibling --archetype web >/dev/null
SIBLING_ADD="$($CPROJ deps add sibling figlet --json)"
SIBLING_IMAGE="$(json_value "$SIBLING_ADD" 'd.image')"
[ "$SIBLING_IMAGE" = "$IMAGE" ] \
  && ok "the second project resolves to the identical image tag" || bad "the same base image and packages produced different tags"
$CPROJ delete sibling --force >/dev/null

# ── 3. Error paths (§6) ────────────────────────────────────────────────────────
head "3. The §6 error paths"

DUP="$($CPROJ deps add myapp figlet --json 2>/dev/null || true)"
json_assert "$DUP" 'd.error && d.error.code === "PACKAGE_ATTACHED"' \
  && ok "declaring the same package twice is PACKAGE_ATTACHED" || bad "a duplicate declaration was accepted"

NOTATT="$($CPROJ deps remove myapp ghost-pkg --json 2>/dev/null || true)"
json_assert "$NOTATT" 'd.error && d.error.code === "PACKAGE_NOT_ATTACHED"' \
  && ok "removing what is not declared is PACKAGE_NOT_ATTACHED" || bad "a bogus removal was accepted"

GHOST="$($CPROJ deps list ghost --json 2>/dev/null || true)"
json_assert "$GHOST" 'd.error && d.error.code === "PROJECT_NOT_FOUND"' \
  && ok "an unknown project is PROJECT_NOT_FOUND" || bad "deps list resolved a project that does not exist"

BADNAME="$($CPROJ deps add myapp 'Not A Package' --json 2>/dev/null || true)"
json_assert "$BADNAME" 'd.error && d.error.code === "INVALID_ARGUMENT"' \
  && ok "an unusable package name is INVALID_ARGUMENT" || bad "a bad package name was accepted"

# ── 4. The Docker half: up builds the derived image, package present ─────────
head "4. \`up\` builds the derived image; the running container has the package"

DOCKER_OK=0
if [ "${CPROJ_SKIP_DOCKER:-0}" = "1" ]; then
  skip "CPROJ_SKIP_DOCKER=1 — skipping the Docker half"
elif ! docker version --format '{{.Server.Version}}' >/dev/null 2>&1; then
  skip "no Docker daemon — skipping the Docker half (the offline checks above still ran)"
else
  DOCKER_OK=1
fi

if [ "$DOCKER_OK" = "1" ]; then
  docker rm -f cproj-myapp >/dev/null 2>&1 || true
  docker volume rm -f cproj-myapp-home >/dev/null 2>&1 || true

  if ! docker image inspect claude-web:latest >/dev/null 2>&1; then
    printf '    building claude-web (first run only, this takes a few minutes)…\n'
    $CPROJ build --archetype web >/dev/null 2>&1 || bad "cproj build failed"
  fi

  UP="$($CPROJ up myapp --json)" || bad "up myapp exited non-zero"
  json_assert "$UP" "d.state === 'running'" && ok "myapp is running" || bad "myapp did not come up"

  docker exec cproj-myapp dpkg -s figlet >/dev/null 2>&1 \
    && ok "the declared package is installed in the running container" || bad "figlet is not installed"

  RUNNING_ADD="$($CPROJ deps add myapp second-pkg --json 2>/dev/null || true)"
  json_assert "$RUNNING_ADD" 'd.error && d.error.code === "PROJECT_RUNNING"' \
    && ok "deps add on a running project is PROJECT_RUNNING" || bad "a running project accepted a deps add"

  # Restart: no root at runtime, the package must simply still be there —
  # Docker's own build cache is what makes the repeat `up` cheap (no
  # apt-get re-run), not a re-install.
  $CPROJ down myapp >/dev/null || bad "down myapp exited non-zero"
  $CPROJ up myapp --json >/dev/null || bad "restarting myapp exited non-zero"
  docker exec cproj-myapp dpkg -s figlet >/dev/null 2>&1 \
    && ok "the package survives a down/up cycle" || bad "figlet is missing after the restart"

  # deps remove, then up: reverts to the plain base image.
  $CPROJ down myapp >/dev/null
  $CPROJ deps remove myapp figlet >/dev/null || bad "deps remove exited non-zero"
  $CPROJ up myapp --json >/dev/null || bad "up after deps remove exited non-zero"
  grep -q 'image: claude-web:latest' "$MOUNTED/myapp/docker-compose.yml" \
    && ok "compose reverted to the plain base image" || bad "compose still references a derived image"
  docker exec cproj-myapp dpkg -s figlet >/dev/null 2>&1 \
    && bad "figlet is still installed after deps remove" || ok "the plain base image (no figlet) is what's actually running"

  $CPROJ down myapp >/dev/null
fi

# ── Summary ───────────────────────────────────────────────────────────────────
printf '\n\033[1mPhase 13: %d passed, %d failed\033[0m\n' "$pass" "$fail"
[ "$fail" -eq 0 ] || exit 1
printf '\033[32mDone-check passed.\033[0m\n'
