#!/usr/bin/env bash
# Phase 16 done-check — the rename: the app (docs/phases/16-rename-app.md).
# Finishes phase 15 on the Swift side: `Cproj`/`cproj`/`CPROJ_`/`claude-yard`/
# `claude_yard` must be gone from every .swift file, from app/README.md, and
# from CLAUDE.md's App section — everything this side of the boundary can
# rename without touching Xcode.
#
# What stays out of scope, by CLAUDE.md's environment boundary (never
# .xcodeproj/.pbxproj, never xcodebuild): the outer `app/claude-yard/` and
# `app/claude-yard/claude-yard/` directories, the target/scheme/product name,
# the bundle identifier, and the scheme's hard-coded cproj.js path. Those are
# the phase's MANUAL prerequisite, still the human's to do in Xcode; this
# script reports them as such rather than failing on them.
#
#   bash test/phase16-done-check.sh
set -uo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO"

pass=0
fail=0
manual=0

ok()   { pass=$((pass + 1)); if [ -n "${VERBOSE:-}" ]; then printf '  \033[32m✓\033[0m %s\n' "$1"; fi; }
bad()  { printf '  \033[31m✗\033[0m %s\n' "$1"; fail=$((fail + 1)); }
todo() { printf '  \033[33m⚠\033[0m %s\n' "$1"; manual=$((manual + 1)); }
head() { printf '\n\033[1m%s\033[0m\n' "$1"; }

# ── 0. The MANUAL prerequisite (the human, in Xcode) ────────────────────────────
head "0. MANUAL prerequisite (docs/phases/16-rename-app.md)"

PBXPROJ="app/claude-yard/claude-yard.xcodeproj/project.pbxproj"
SCHEME="app/claude-yard/claude-yard.xcodeproj/xcshareddata/xcschemes/claude-yard.xcscheme"

if [ -d "app/Bardolier/Bardolier" ]; then
  ok "app/Bardolier/Bardolier exists — the outer directories are renamed"
else
  todo "app/claude-yard/ and app/claude-yard/claude-yard/ are still named claude-yard — rename them in Xcode and re-point the synchronized folder group"
fi

if [ -f "$PBXPROJ" ] && grep -q 'PRODUCT_BUNDLE_IDENTIFIER = "com.mw.claude-yard"' "$PBXPROJ"; then
  todo "the bundle identifier is still com.mw.claude-yard — rename the target/scheme/product to Bardolier in Xcode"
elif [ -f "$PBXPROJ" ]; then
  ok "the bundle identifier is no longer com.mw.claude-yard"
else
  todo "$PBXPROJ not found"
fi

if [ -f "$SCHEME" ] && grep -q 'cproj\.js' "$SCHEME"; then
  todo "the scheme's environment still points at cli/bin/cproj.js (which no longer exists) — fix it in Xcode"
elif [ -f "$SCHEME" ]; then
  ok "the scheme no longer names cproj.js"
fi

# ── 1. The old name is gone from every renameable file ─────────────────────────
head "1. old name absent, app/ included"

OLD_NAME="cp""roj"
OLD_YARD="claude-""yard"
OLD_ENV="CP""ROJ_"
OLD_UNDERSCORE="claude_""yard"

# Still excluded, and still for the reason phase15-done-check.sh gives: these
# name the app's *actual* Swift source tree by its real, on-disk path — which
# is still `app/claude-yard/claude-yard` until the human's MANUAL Xcode rename
# (§ below) moves it. That path string is accurate, not leftover debt.
HITS="$(grep -rlEi "${OLD_NAME}|${OLD_YARD}|${OLD_ENV}|${OLD_UNDERSCORE}" . \
  --include='*' -I 2>/dev/null \
  | grep -v '^\./node_modules/' \
  | grep -v '^\./\.git/' \
  | grep -v '^\./\.claude/' \
  | grep -v '^\./app/claude-yard/claude-yard\.xcodeproj/' \
  | grep -v '^\./docs/phases/15-rename-cli\.md$' \
  | grep -v '^\./docs/phases/16-rename-app\.md$' \
  | grep -v '^\./test/phase15-done-check\.sh$' \
  | grep -v '^\./test/phase16-done-check\.sh$' \
  | grep -v '^\./test/phase[5679]-done-check\.sh$' \
  | grep -v '^\./test/phase7\.test\.ts$' \
  | grep -v '^\./test/app-models\.test\.ts$' \
  || true)"

if [ -z "$HITS" ]; then
  ok "no leftover old name outside the Xcode project file and the paths that name the real (not yet renamed) directory"
else
  bad "old name still present:"
  printf '%s\n' "$HITS" | sed 's/^/      /'
fi

# ── 2. The Swift files exist under their new names ────────────────────────────
head "2. Renamed Swift sources"

APP="app/claude-yard/claude-yard"
for file in \
  "$APP/Bardolier/BardolierModels.swift" \
  "$APP/Bardolier/BardolierError.swift" \
  "$APP/Bardolier/BardolierExecutable.swift" \
  "$APP/Bardolier/BardolierClient.swift" \
  "$APP/BardolierStore.swift" \
  "$APP/BardolierApp.swift" \
  "$APP/Shell/BardolierTerminal.swift" \
  "$APP/Preferences/AppPreferences.swift"
do
  [ -f "$file" ] && ok "$file" || bad "$file is missing"
done

for gone in \
  "$APP/Cproj" \
  "$APP/CprojStore.swift" \
  "$APP/claude_yardApp.swift" \
  "$APP/Shell/CprojTerminal.swift"
do
  [ ! -e "$gone" ] && ok "$gone no longer exists" || bad "$gone is a leftover — deletions must be real deletions"
done

# ── 3. Swift type-checks (this environment has swiftc despite the Linux-dev-
#      container framing — see the project memory) ────────────────────────────
head "3. Type-check"

if command -v swiftc >/dev/null 2>&1 && SDK="$(xcrun --show-sdk-path 2>/dev/null)" && [ -n "$SDK" ]; then
  if swiftc -typecheck -swift-version 5 -default-isolation MainActor \
      -target arm64-apple-macos15.0 -sdk "$SDK" \
      $(find "$APP" -name '*.swift') >/dev/null 2>&1; then
    ok "the renamed sources type-check"
  else
    bad "the renamed sources do not type-check"
  fi
else
  todo "no Swift toolchain here — Xcode will type-check on ⌘B (CLAUDE.md boundary)"
fi

# ── 4. Contract tests ───────────────────────────────────────────────────────────
head "4. npm run test:quiet"

if npm run test:quiet >/tmp/phase16-npm.log 2>&1; then
  ok "npm run test:quiet (app-models.test.ts, phase7.test.ts, everything else)"
else
  bad "npm run test:quiet failed:"
  tail -30 /tmp/phase16-npm.log | sed 's/^/      /'
fi

# ── Summary ────────────────────────────────────────────────────────────────────
printf '\n\033[1mPhase 16: %d passed, %d failed\033[0m\n' "$pass" "$fail"

if [ "$manual" -gt 0 ]; then
  cat <<'MANUAL'

Once §0's items are done, ⌘B: confirm it still builds, launches, finds
bardolier, and shows a project list — the first-run panel naming `bardolier`
rather than `cproj` is the visible proof the executable search was renamed
too. Then re-run this script: the exclusions in §1 for the still-real
`app/claude-yard/claude-yard` path (in test/phase5-9-done-check.sh,
test/app-models.test.ts, test/phase7.test.ts, and the Xcode project files)
become stale and should be deleted along with updating those literal paths.
MANUAL
fi

[ "$fail" -eq 0 ] || exit 1
printf '\033[32mDone-check passed (%d item(s) still the human'"'"'s, in Xcode).\033[0m\n' "$manual"
