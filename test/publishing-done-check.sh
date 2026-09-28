#!/usr/bin/env bash
# The publishing set (docs/development/phases/23-publishing-set.md): a
# stranger's clone has a LICENSE, a NOTICE, a README with a security section,
# no leftover developer-machine paths, and no `--dangerously-skip-permissions`
# anywhere. Scrubbing this project's own former names is `naming`'s job, not
# repeated here.
#
#   bash test/publishing-done-check.sh
#   VERBOSE=1 …    print every passing line
set -uo pipefail

source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

# What would actually ship: tracked files, plus anything new .gitignore
# doesn't already exclude — never gitignored junk (Xcode's own
# xcuserdata/*.xcuserstate) or this script's own patterns, which necessarily
# NAME the strings it is checking the rest of the tree doesn't contain.
TRACKED_FILES() {
  { git ls-files; git ls-files --others --exclude-standard; } | sort -u | grep -v '^test/publishing-done-check\.sh$'
}

grep_tracked() { # grep_tracked <pattern...> — case-sensitive, extended regex, over TRACKED_FILES
  TRACKED_FILES | tr '\n' '\0' | xargs -0 grep -lE "$@" 2>/dev/null || true
}

# ── 1. LICENSE, NOTICE, README, CONTRIBUTING ────────────────────────────────
head "1. The files a stranger's clone needs"

[ -f LICENSE ] && ok "LICENSE exists" || bad "LICENSE is missing"
grep -q 'Apache License' LICENSE 2>/dev/null && grep -q 'Version 2.0' LICENSE 2>/dev/null \
  && ok "LICENSE is Apache 2.0" || bad "LICENSE is not Apache 2.0"

[ -f NOTICE ] && ok "NOTICE exists" || bad "NOTICE is missing"
grep -qi 'not affiliated with' NOTICE 2>/dev/null \
  && ok "NOTICE disclaims Anthropic affiliation" || bad "NOTICE has no non-affiliation line"

[ -f README.md ] && ok "README.md exists" || bad "README.md is missing"
for section in 'Prerequisites\|## Prerequisites' '## Install' '## Quickstart' '## Security' '## Licence\|## License'; do
  grep -qi "$section" README.md 2>/dev/null \
    && ok "README.md has a $section section" || bad "README.md is missing a $section section"
done
grep -qi 'Mac' README.md 2>/dev/null && grep -qi 'Linux' README.md 2>/dev/null \
  && ok "README.md says what the tool is: a Mac driving Linux containers" \
  || bad "README.md does not describe the host/container split"

[ -f CONTRIBUTING.md ] && ok "CONTRIBUTING.md exists" || bad "CONTRIBUTING.md is missing"

# ── 2. Security posture is stated, not just implied ─────────────────────────
head "2. Security posture (docs/development/phases/23-publishing-set.md)"

# Markdown is exempt: the README's Security section and this phase's own spec
# both have to NAME the flag to disclaim it. What matters is that nothing
# actually PASSES it — no Dockerfile, script, or source file.
CODE_HITS="$(TRACKED_FILES | grep -v '\.md$' | tr '\n' '\0' | xargs -0 grep -liE 'dangerously-skip-permissions' 2>/dev/null || true)"
if [ -z "$CODE_HITS" ]; then
  ok "dangerously-skip-permissions is passed nowhere in the tree (docs may still name it to disclaim it)"
else
  bad "dangerously-skip-permissions appears in: $(echo "$CODE_HITS" | tr '\n' ' ')"
fi

grep -qi 'environment boundary, not a sandbox' README.md 2>/dev/null \
  && ok "README states the container is an environment boundary, not a sandbox" \
  || bad "README does not make the sandbox distinction"
grep -q 'PASSTHROUGH_ENV' README.md 2>/dev/null \
  && ok "README names PASSTHROUGH_ENV" || bad "README does not mention PASSTHROUGH_ENV"

# ── 3. No personal path or email in any tracked-or-working file ─────────────
head "3. Personal scrub"

# The Xcode scheme is a known, tracked exception: CLAUDE.md forbids editing
# .xcodeproj contents, so this is the human's, not ours — see 4.
SCHEME_PATH="app/bardolier/bardolier.xcodeproj/xcshareddata/xcschemes/bardolier.xcscheme"
HITS="$(grep_tracked '(/Users/mark([^0-9a-zA-Z]|$))|happymark' | grep -v "^${SCHEME_PATH}\$" || true)"
if [ -z "$HITS" ]; then
  ok "no personal home-directory path outside the (MANUAL) Xcode scheme"
else
  bad "personal path found in: $(echo "$HITS" | tr '\n' ' ')"
fi

# example.com is the reserved, RFC-2606 domain the test suite's own fixtures
# use for a fake git-author email — not a leak.
EMAIL_HITS="$(TRACKED_FILES | tr '\n' '\0' | xargs -0 grep -noE '[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}' 2>/dev/null \
  | grep -v '@example\.com' || true)"
if [ -z "$EMAIL_HITS" ]; then
  ok "no real email address anywhere in the tree (only example.com fixtures)"
else
  bad "a non-fixture email address was found: $(echo "$EMAIL_HITS" | tr '\n' ' ')"
fi

grep -qx '.claude/settings.local.json' .gitignore 2>/dev/null \
  && ok ".claude/settings.local.json is gitignored" || bad ".claude/settings.local.json is not in .gitignore"

# ── 4. MANUAL: the Xcode scheme (the human, in Xcode) ───────────────────────
head "4. MANUAL: the Xcode scheme's hard-coded path"

SCHEME="app/bardolier/bardolier.xcodeproj/xcshareddata/xcschemes/bardolier.xcscheme"
if [ -f "$SCHEME" ] && grep -q '/Users/mark' "$SCHEME"; then
  todo "$SCHEME still hard-codes a developer-machine path in BDLR_BIN/BDLR_SSD_ROOT — clear those env overrides in Xcode (bardolier install makes them unnecessary)"
elif [ -f "$SCHEME" ]; then
  ok "the scheme no longer hard-codes a developer-machine path"
else
  bad "$SCHEME not found"
fi

# ── 5. package.json metadata ─────────────────────────────────────────────────
head "5. package.json metadata"

for pkg in package.json cli/package.json; do
  node --input-type=module -e "
    import { readFileSync } from 'node:fs'
    const p = JSON.parse(readFileSync(process.argv[1], 'utf8'))
    if (p.license !== 'Apache-2.0') process.exit(1)
    if (!p.repository || !p.repository.url) process.exit(1)
  " "$pkg" 2>/dev/null \
    && ok "$pkg declares license and repository" || bad "$pkg is missing license or repository"
done

grep -q '"done-check": "bash \.\./test/regression\.sh"' cli/package.json \
  && ok "cli/package.json's done-check points at a script that exists" \
  || bad "cli/package.json's done-check is stale"

# ── 6. Docs triage ────────────────────────────────────────────────────────────
head "6. Docs triage (development scaffolding vs. user docs)"

for path in docs/cli-spec.md docs/app-spec.md docs/migration-guide.md; do
  [ -f "$path" ] && ok "$path stays at docs/ (user-facing)" || bad "$path is missing from docs/"
done
for path in docs/phases docs/archive docs/retrospective.md docs/migration-guide-gaps.md; do
  [ -e "$path" ] && bad "$path should have moved under docs/development/" || ok "$path is not at the old location"
done
for path in docs/development/phases docs/development/archive docs/development/retrospective.md docs/development/migration-guide-gaps.md; do
  [ -e "$path" ] && ok "$path exists" || bad "$path is missing"
done

# ── 7. The migrate-project skill resolves what it references ────────────────
head "7. migrate-project skill"

SKILL=".claude/skills/migrate-project/SKILL.md"
if [ -f "$SKILL" ]; then
  ok "$SKILL exists"
  for ref in docs/migration-guide.md docs/development/migration-guide-gaps.md; do
    grep -q "$ref" "$SKILL" && [ -f "$ref" ] \
      && ok "$SKILL's reference to $ref resolves" || bad "$SKILL references $ref, which is missing or not named there"
  done
else
  bad "$SKILL is missing"
fi

# ── Summary ───────────────────────────────────────────────────────────────────
summary "Publishing"
