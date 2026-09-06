#!/usr/bin/env bash
# Phase 19 done-check — the project layout (docs/phases/19-project-layout.md).
#
# A project directory is four bind-mounted folders around bardolier's own files,
# with the service data among them. What only a real run can show: postgres
# writing into `data/postgres/` on the host disk, `/data` read-only inside the
# dev container, `project.yml` invisible from in there, and a `git clean -xdf`
# in `work/` leaving the database alone.
#
#   bash test/phase19-done-check.sh
#   BARDOLIER_SKIP_DOCKER=1 …    offline assertions only
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

# The REAL path, not the symlinked one: Docker Desktop shares `/private/var/…`
# and would otherwise create a bind source inside its VM, where the host never
# sees the data — which is the whole thing this phase is about.
TMP="$(cd "$(mktemp -d)" && pwd -P)"
DOCKER_OK=0
cleanup() {
  if [ "$DOCKER_OK" = "1" ]; then
    docker rm -f bardolier-alpha bardolier-alpha-postgres >/dev/null 2>&1 || true
  fi
  rm -rf "$TMP"
}
trap cleanup EXIT

MOUNTED="$TMP/ssd/claude-projects"
mkdir -p "$MOUNTED"
# HOME is deliberately NOT sandboxed: `docker compose` is a CLI plugin under
# ~/.docker, and a fake home turns every compose call into "unknown flag".
# BARDOLIER_CONFIG is what keeps this run's config out of the real one (§8).
export BARDOLIER_CONFIG="$TMP/config.yml"
export BARDOLIER_ROOT="$MOUNTED"

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

# ── 1. new: four folders, one seed, no ignore file ────────────────────────────
head "1. \`new\` makes four folders, one seed, and no ignore file (§3, §10)"

NEW="$($BARDOLIER new alpha --archetype web --services postgres --json)" || bad "new exited non-zero"
json_assert "$NEW" 'd.seeded.length === 1 && d.seeded[0] === "work/CLAUDE.md"' \
  && ok "the one seed is work/CLAUDE.md" || bad "new seeded something other than work/CLAUDE.md"

ENTRIES="$(cd "$MOUNTED/alpha" && ls -A | sort | tr '\n' ' ')"
[ "$ENTRIES" = "data docker-compose.yml home local project.yml work " ] \
  && ok "the project directory holds exactly the four folders and bardolier's two files" \
  || bad "unexpected project directory contents: $ENTRIES"

[ -f "$MOUNTED/alpha/work/CLAUDE.md" ] && ok "work/CLAUDE.md is where the agent's cwd will find it" || bad "no work/CLAUDE.md"
[ -f "$MOUNTED/alpha/data/.metadata_never_index" ] \
  && ok "data/ opts out of Spotlight indexing" || bad "data/.metadata_never_index is missing"
[ -d "$MOUNTED/alpha/data/postgres" ] \
  && ok "the attached service's bind source exists before compose ever runs" || bad "data/postgres was not created"

IGNORES="$(find "$MOUNTED" \( -name '.gitignore' -o -name '.dockerignore' \) -print | tr '\n' ' ')"
[ -z "$IGNORES" ] \
  && ok "no .gitignore or .dockerignore anywhere — there is no repo root to seed" \
  || bad "an ignore file was seeded: $IGNORES"

# ── 2. compose: four relative binds, /data read-only, no project volume ───────
head "2. The generated file binds four folders and declares no project volume (§9)"

COMPOSE="$MOUNTED/alpha/docker-compose.yml"
for bind in './work:/work' './data:/data:ro' './local:/local' './home:/state/home'; do
  grep -q -- "- $bind" "$COMPOSE" && ok "binds $bind" || bad "missing bind $bind"
done
grep -q -- '- ./data/postgres:/var/lib/postgresql/data' "$COMPOSE" \
  && ok "postgres binds ./data/postgres at its catalogue mount" || bad "postgres does not bind its data directory"
grep -q "$TMP" "$COMPOSE" && bad "the compose file hard-codes an absolute path" || ok "every bind is relative — the folder stays relocatable"

node --input-type=module -e "
  import { readFileSync } from 'node:fs'
  import { parse } from 'yaml'
  const doc = parse(readFileSync(process.argv[1], 'utf8'))
  const names = Object.keys(doc.volumes ?? {})
  if (names.length !== 1 || names[0] !== 'bardolier-uv-cache') process.exit(1)
  if (doc.volumes['bardolier-uv-cache'].external !== true) process.exit(1)
" "$COMPOSE" 2>/dev/null \
  && ok "the only named volume left is the shared, external toolchain cache" \
  || bad "the compose file declares a project-owned named volume"

# ── 3. git: work/ is the only working tree, and it cannot reach the data ──────
head "3. \`work/\` is the only working tree, and \`git clean -xdf\` cannot reach data/"

echo 'seed data' > "$MOUNTED/alpha/data/postgres/PG_VERSION"
(
  cd "$MOUNTED/alpha/work"
  git init -q .
  git -c user.email=t@example.com -c user.name=t add -A
  git -c user.email=t@example.com -c user.name=t commit -qm 'seed'
)
CLEAN="$(cd "$MOUNTED/alpha/work" && git status --porcelain)"
[ -z "$CLEAN" ] && ok "git status in work/ is clean with no .gitignore at all" || bad "git status is dirty: $CLEAN"

(cd "$MOUNTED/alpha/work" && git clean -xdf -q)
[ -f "$MOUNTED/alpha/data/postgres/PG_VERSION" ] \
  && ok "git clean -xdf in work/ left data/ untouched" || bad "git clean destroyed the service data"
[ -f "$MOUNTED/alpha/project.yml" ] && ok "and left the manifest alone" || bad "git clean destroyed project.yml"
rm -rf "$MOUNTED/alpha/work/.git"

# ── 4. The real run ───────────────────────────────────────────────────────────
head "4. The data lands on the host disk, and /data is read-only in the container"

if [ -n "${BARDOLIER_SKIP_DOCKER:-}" ] || ! docker info >/dev/null 2>&1; then
  skip "no Docker daemon — the bind-mount half needs a real container"
else
  DOCKER_OK=1
  if ! docker image inspect bardolier-web:latest >/dev/null 2>&1; then
    printf '    building bardolier-web (first run only, this takes a few minutes)…\n'
    $BARDOLIER build --archetype web >/dev/null 2>&1 || bad "bardolier build failed"
  fi

  rm -f "$MOUNTED/alpha/data/postgres/PG_VERSION"
  printf '    starting alpha (pulls postgres:17 on a cold cache)…\n'
  $BARDOLIER up alpha --json >/dev/null || bad "up exited non-zero"
  # initdb takes a moment; poll rather than guess at a sleep.
  for _ in $(seq 1 30); do
    [ -f "$MOUNTED/alpha/data/postgres/PG_VERSION" ] && break
    sleep 1
  done

  [ -f "$MOUNTED/alpha/data/postgres/PG_VERSION" ] \
    && ok "postgres initialised into data/postgres/ — visible from the host, on the project's own disk" \
    || bad "no PG_VERSION on the host: the data did not reach the disk the project is on"

  docker exec bardolier-alpha bash -lc 'test -f /work/CLAUDE.md' >/dev/null 2>&1 \
    && ok "the dev container works in work/" || bad "work/ is not mounted at /work"
  docker exec bardolier-alpha bash -lc 'test -e /work/project.yml' >/dev/null 2>&1 \
    && bad "project.yml is reachable from the dev container" || ok "project.yml is above work/ and invisible from in there"
  docker exec bardolier-alpha bash -lc 'test -f /data/postgres/PG_VERSION' >/dev/null 2>&1 \
    && ok "the data is visible at /data for inspection" || bad "/data does not show the service data"
  docker exec bardolier-alpha bash -lc 'touch /data/nope' >/dev/null 2>&1 \
    && bad "/data is writable from the dev container" || ok "/data is read-only — a live data directory is not written from here"
  docker exec bardolier-alpha bash -lc 'touch /state/home/writable && rm /state/home/writable' >/dev/null 2>&1 \
    && ok "\$HOME is writable by the container's own uid" || bad "\$HOME is not writable in the container"

  # Survives the stop: the whole point of the data being a directory.
  $BARDOLIER down alpha --no-handoff >/dev/null || bad "down exited non-zero"
  [ -f "$MOUNTED/alpha/data/postgres/PG_VERSION" ] && ok "the data survives down" || bad "down destroyed the data"

  # And a hand-deleted home/ heals rather than coming back root-owned.
  rm -rf "$MOUNTED/alpha/home"
  $BARDOLIER up alpha --json >/dev/null || bad "up after deleting home/ exited non-zero"
  [ -d "$MOUNTED/alpha/home" ] && ok "a hand-deleted home/ is recreated by up" || bad "up did not recreate home/"
  docker exec bardolier-alpha bash -lc 'touch /state/home/again && rm /state/home/again' >/dev/null 2>&1 \
    && ok "and it is writable, not a root-owned directory Docker made" || bad "the recreated \$HOME is not writable"
  [ -f "$MOUNTED/alpha/data/postgres/PG_VERSION" ] && ok "the data survives the restart" || bad "the restart lost the data"

  $BARDOLIER down alpha --no-handoff >/dev/null || bad "down exited non-zero"
fi

# ── 5. Detaching orphans the directory ────────────────────────────────────────
head "5. \`service remove\` keeps data/postgres/ and it becomes a directory orphan"

[ -f "$MOUNTED/alpha/data/postgres/PG_VERSION" ] || echo 'seed data' > "$MOUNTED/alpha/data/postgres/PG_VERSION"

$BARDOLIER service remove alpha postgres --json >/dev/null || bad "service remove exited non-zero"
[ -d "$MOUNTED/alpha/data/postgres" ] && ok "detaching kept the data directory" || bad "detaching destroyed the data"

ORPHANED="$($BARDOLIER volumes orphaned --json)" || bad "volumes orphaned exited non-zero"
json_assert "$ORPHANED" 'd.orphaned.some(v => v.name === "alpha/postgres" && v.kind === "directory")' \
  && ok "it is listed as a directory orphan" || bad "the orphan did not appear as a directory"
json_assert "$ORPHANED" "d.orphaned.find(v => v.name === 'alpha/postgres').path === '$MOUNTED/alpha/data/postgres'" \
  && ok "with the path a human can go and look at" || bad "the orphan carries no path"
json_assert "$ORPHANED" 'd.orphaned.find(v => v.name === "alpha/postgres").size_bytes > 0' \
  && ok "and a size measured on disk ($(json_value "$ORPHANED" 'd.orphaned.find(v => v.name === "alpha/postgres").size_human'))" \
  || bad "the orphan has no size"

# ── 6. delete refuses, --purge takes it ───────────────────────────────────────
head "6. \`delete\` refuses PROJECT_HAS_DATA; \`--purge\` takes everything"

REFUSED="$($BARDOLIER delete alpha --force --json 2>/dev/null || true)"
json_assert "$REFUSED" 'd.error && d.error.code === "PROJECT_HAS_DATA"' \
  && ok "a project holding data refuses to be deleted" || bad "delete did not refuse: $REFUSED"
json_assert "$REFUSED" "d.error.message.includes('$MOUNTED/alpha/data') && d.error.details.bytes > 0" \
  && ok "and names what it would destroy, with its size" || bad "the refusal does not name the data"
[ -d "$MOUNTED/alpha" ] && ok "the refusal left the project alone" || bad "the refused delete removed the project"

$BARDOLIER delete alpha --force --purge --json >/dev/null || bad "delete --purge exited non-zero"
[ ! -e "$MOUNTED/alpha" ] && ok "--purge removed the folder, data and home with it" || bad "the project directory survived --purge"

json_assert "$($BARDOLIER volumes orphaned --json)" 'd.orphaned.every(v => !v.name.startsWith("alpha/"))' \
  && ok "and nothing of it is left to reclaim" || bad "a deleted project still has orphans"

# ── 7. Everything below ───────────────────────────────────────────────────────
head "7. Test suites, typecheck, and earlier done-checks"

npm run test:quiet >/dev/null 2>&1 && ok "npm test" || bad "npm test"
npm run typecheck >/dev/null 2>&1 && ok "npm run typecheck" || bad "npm run typecheck"

if [ -z "${BARDOLIER_REGRESSION:-}" ]; then
  for phase in $(seq 0 18); do
    if env -u BARDOLIER_CONFIG -u BARDOLIER_ROOT bash "test/phase${phase}-done-check.sh" >/dev/null 2>&1; then
      ok "phase ${phase} done-check"
    else
      bad "phase ${phase} done-check"
    fi
  done
else
  skip "earlier phases (the regression ladder is walking them)"
fi

printf '\n\033[1mPhase 19: %d passed, %d failed\033[0m\n' "$pass" "$fail"
[ "$fail" -eq 0 ] || exit 1
printf '\033[32mDone-check passed.\033[0m\n'
