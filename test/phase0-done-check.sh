#!/usr/bin/env bash
# Phase 0 done-check — `bardolier --help` lists every command, the schema and data
# files parse, and the error-code list exists in code.
#
#   bash test/phase0-done-check.sh
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO"

BARDOLIER="node cli/bin/bardolier.js"
pass=0
fail=0

ok()   { pass=$((pass + 1)); if [ -n "${VERBOSE:-}" ]; then printf '  \033[32m✓\033[0m %s\n' "$1"; fi; }
bad()  { printf '  \033[31m✗\033[0m %s\n' "$1"; fail=$((fail + 1)); }
head() { printf '\n\033[1m%s\033[0m\n' "$1"; }

check() { # check <description> <command...>
  local desc="$1"; shift
  if "$@" >/dev/null 2>&1; then ok "$desc"; else bad "$desc"; fi
}

# ── 1. bardolier --help lists all commands ────────────────────────────────────────
head "1. \`bardolier --help\` lists every command in cli-spec.md §6"

HELP="$($BARDOLIER --help)"
COMMANDS=(
  "new <name> --archetype <a> [--services a,b]"
  "list"
  "status [<name>]"
  "up <name> [--no-shell]"
  "down <name>"
  "delete <name> [--force] [--keep-data | --purge]"
  "service add <project> <svc>"
  "service remove <project> <svc>"
  "service list <project>"
  "shell <name> [--print]"
  "volumes orphaned"
  "volumes rm <name> [--force]"
  "down-all"
  "eject"
  "doctor"
  "build [--archetype <a>]"
)
for cmd in "${COMMANDS[@]}"; do
  if grep -Fq -- "$cmd" <<<"$HELP"; then ok "$cmd"; else bad "MISSING: $cmd"; fi
done

# ── 2. Schema and data files parse ────────────────────────────────────────────
head "2. Schema and data files parse"

for schema in project services status error; do
  check "cli/schema/$schema.schema.json parses" \
    node -e "JSON.parse(require('fs').readFileSync('cli/schema/$schema.schema.json','utf8'))"
done
check "cli/defaults/services.yml parses" \
  node -e "import('yaml').then(y=>y.parse(require('fs').readFileSync('cli/defaults/services.yml','utf8')))"
check "test/fixtures/project.example.yml parses" \
  node -e "import('yaml').then(y=>y.parse(require('fs').readFileSync('test/fixtures/project.example.yml','utf8')))"

# ── 3. The §7 status fixture validates ────────────────────────────────────────
head "3. The §7 status fixture validates and round-trips"

if node --input-type=module -e "
  import { readFileSync } from 'node:fs'
  import { validate } from './cli/src/schema.ts'
  const fixture = JSON.parse(readFileSync('test/fixtures/status.example.json','utf8'))
  const first = validate('status', fixture)
  if (!first.valid) { console.error(first.errors.join('\n')); process.exit(1) }
  const round = JSON.parse(JSON.stringify(fixture))
  if (JSON.stringify(round) !== JSON.stringify(fixture)) { console.error('round-trip mismatch'); process.exit(1) }
  if (!validate('status', round).valid) process.exit(1)
" 2>/dev/null; then
  ok "status.example.json validates against status.schema.json and round-trips"
else
  bad "status.example.json failed validation or round-trip"
fi

check "project.example.yml validates against project.schema.json" \
  node --input-type=module -e "
    import { readFileSync } from 'node:fs'
    import { parse } from 'yaml'
    import { validate } from './cli/src/schema.ts'
    const m = parse(readFileSync('test/fixtures/project.example.yml','utf8'))
    process.exit(validate('project', m).valid ? 0 : 1)
  "
check "defaults/services.yml validates against services.schema.json" \
  node --input-type=module -e "
    import { readFileSync } from 'node:fs'
    import { parse } from 'yaml'
    import { validate } from './cli/src/schema.ts'
    const c = parse(readFileSync('cli/defaults/services.yml','utf8'))
    process.exit(validate('services', c).valid ? 0 : 1)
  "

# ── 4. The error-code list exists in code ─────────────────────────────────────
head "4. The error-code list exists in code (cli/src/errors.ts)"

CODES="$(node --input-type=module -e "
  import { ERROR_CODES } from './cli/src/errors.ts'
  console.log(ERROR_CODES.join(' '))
")"
for code in SSD_NOT_MOUNTED PROJECT_EXISTS PROJECT_NOT_FOUND PROJECT_RUNNING PROJECT_STOPPED \
            SERVICE_UNKNOWN SERVICE_ATTACHED SERVICE_NOT_ATTACHED PORT_UNAVAILABLE \
            VOLUME_IN_USE EJECT_BLOCKED DOCKER_UNAVAILABLE; do
  if grep -qw -- "$code" <<<"$CODES"; then ok "$code"; else bad "MISSING: $code"; fi
done
printf '    all codes: %s\n' "$CODES"

# ── 5. Renderers are separate; --json emits the §2 envelope ───────────────────
head "5. --json emits a single JSON value; failures use the §2 error envelope"

# Phase 1 implemented `status`, so the guaranteed-failing invocation used here
# is a rejected FLAG instead: INVALID_ARGUMENT stays a failure in every phase,
# which keeps this a §2 envelope check rather than a stub check.
FAILING=(status --nope)

ENVELOPE="$($BARDOLIER "${FAILING[@]}" --json 2>/dev/null || true)"
if node -e "
  const v = JSON.parse(process.argv[1])
  if (!v.error || typeof v.error.code !== 'string' || typeof v.error.message !== 'string') process.exit(1)
" "$ENVELOPE" 2>/dev/null; then
  ok "a failing command prints { error: { code, message } } on stdout"
else
  bad "failure envelope is malformed: $ENVELOPE"
fi

if $BARDOLIER "${FAILING[@]}" --json >/dev/null 2>&1; then
  bad "a failing command exited 0 (expected non-zero)"
else
  ok "a failing command exits non-zero"
fi

# Note: capture rather than pipe — under `pipefail` a pipeline would inherit
# the CLI's intentional non-zero exit and mask a matching grep.
HUMAN_ERR="$($BARDOLIER "${FAILING[@]}" 2>&1 >/dev/null || true)"
HUMAN_OUT="$($BARDOLIER "${FAILING[@]}" 2>/dev/null || true)"
if grep -q 'INVALID_ARGUMENT' <<<"$HUMAN_ERR" && [ -z "$HUMAN_OUT" ]; then
  ok "human renderer writes the error to stderr, keeping stdout clean"
else
  bad "human error output did not reach stderr (stderr: '$HUMAN_ERR', stdout: '$HUMAN_OUT')"
fi

# ── 6. Contract tests and typecheck ───────────────────────────────────────────
head "6. Contract tests and typecheck"

check "npm test (contract suite)" npm test
check "npm run typecheck" npm run typecheck

# ── Summary ───────────────────────────────────────────────────────────────────
printf '\n\033[1mPhase 0: %d passed, %d failed\033[0m\n' "$pass" "$fail"
[ "$fail" -eq 0 ] || exit 1
printf '\033[32mDone-check passed.\033[0m\n'
