#!/usr/bin/env bash
# Phase 5 done-check — implementation-plan.md.
#
#   "the app launches as a menu-bar item, calls `cproj status --json`, and your
#    debug view shows correctly decoded projects/services/ports."
#
# Phase 5 is the first phase whose done-check a terminal cannot finish. The
# build, the launch and the click are Xcode's, on the Mac (CLAUDE.md
# § Environment boundary) — nothing here runs xcodebuild, the Simulator, or a
# signing step, and nothing here edits the Xcode project.
#
# What this script CAN do, it does:
#
#   - hold the Swift models to the frozen schemas, in both directions, via
#     `test/app-models.test.ts`. That is the substance of "correctly decoded":
#     a field the models missed fails here rather than in the menu bar.
#   - confirm the sources are where the synchronized folder group will pick
#     them up, so the human's "add files to target" step is a no-op.
#   - read back the two BUILD SETTINGS the app spec requires and Xcode's
#     template does not default to (§1: LSUIElement on, App Sandbox off). It
#     reads the pbxproj; changing it is the human's step.
#   - re-run every earlier phase's check.
#
# The rest is the checklist printed at the end, which is yours to walk.
#
#   bash test/phase5-done-check.sh
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO"

APP="app/claude-yard/claude-yard"
PBXPROJ="app/claude-yard/claude-yard.xcodeproj/project.pbxproj"
pass=0
fail=0
manual=0

ok()   { printf '  \033[32m✓\033[0m %s\n' "$1"; pass=$((pass + 1)); }
bad()  { printf '  \033[31m✗\033[0m %s\n' "$1"; fail=$((fail + 1)); }
todo() { printf '  \033[33m⚠\033[0m %s\n' "$1"; manual=$((manual + 1)); }
head() { printf '\n\033[1m%s\033[0m\n' "$1"; }

# ── 1. The client layer exists where the target will find it ─────────────────
head "1. Sources (app-spec.md §4)"

for file in \
  "$APP/Cproj/CprojModels.swift" \
  "$APP/Cproj/CprojError.swift" \
  "$APP/Cproj/CprojExecutable.swift" \
  "$APP/Cproj/CprojClient.swift" \
  "$APP/CprojStore.swift" \
  "$APP/DebugStatusView.swift" \
  "$APP/claude_yardApp.swift"
do
  [ -f "$file" ] && ok "$file" || bad "$file is missing"
done

if grep -q "fileSystemSynchronizedGroups" "$PBXPROJ"; then
  ok "the target uses a synchronized folder group — new files are in the build already"
else
  todo "the target has no synchronized folder group: add the new .swift files to it in Xcode"
fi

if grep -q "MenuBarExtra" "$APP/claude_yardApp.swift"; then
  ok "the scene is a MenuBarExtra (app-spec.md §1)"
else
  bad "claude_yardApp.swift declares no MenuBarExtra"
fi

# ── 2. Build settings the spec requires (the human's manual step) ────────────
head "2. Build settings (app-spec.md §1, implementation-plan.md Phase 5)"

if grep -q "ENABLE_APP_SANDBOX = NO" "$PBXPROJ"; then
  ok "App Sandbox is off — the app can shell out to cproj"
else
  todo "App Sandbox is still ON. Xcode → target → Signing & Capabilities → remove App Sandbox."
  todo "  Until then every cproj call fails: a sandboxed app may not exec a helper it doesn't ship."
fi

if grep -q "INFOPLIST_KEY_LSUIElement = YES" "$PBXPROJ"; then
  ok "LSUIElement is YES — menu-bar only, no dock icon"
else
  todo "LSUIElement is not set. Xcode → target → Info → \"Application is agent (UIElement)\" = YES."
fi

# ── 3. The models against the frozen schemas ─────────────────────────────────
head "3. Contract (test/app-models.test.ts)"

if npm test >/dev/null 2>&1; then ok "npm test — models mirror the schemas, both directions"; else bad "npm test"; fi
if npm run typecheck >/dev/null 2>&1; then ok "npm run typecheck"; else bad "npm run typecheck"; fi

# ── 4. The CLI the app is a client of ────────────────────────────────────────
head "4. Earlier phases"

for phase in 0 1 2 3 4; do
  if bash "test/phase${phase}-done-check.sh" >/dev/null 2>&1; then
    ok "test/phase${phase}-done-check.sh still passes"
  else
    bad "test/phase${phase}-done-check.sh regressed"
  fi
done

# ── Summary ──────────────────────────────────────────────────────────────────
printf '\n\033[1mPhase 5: %d passed, %d failed, %d manual\033[0m\n' "$pass" "$fail" "$manual"
[ "$fail" -eq 0 ] || exit 1

cat <<'MANUAL'

The half a terminal cannot check — on the Mac, in Xcode:

  1. Fix anything marked ⚠ above (App Sandbox off, LSUIElement YES).
  2. ⌘B. The synchronized folder group means the new files are already in the
     target; confirm they compiled.
  3. Make `cproj` reachable from a GUI app — a Finder-launched app inherits no
     shell PATH. Either point the app straight at this working copy:
       defaults write com.mw.claude-yard CprojPath "$PWD/cli/bin/cproj.js"
     or install it once and let the search find it:
       ln -s "$PWD/cli/bin/cproj.js" /usr/local/bin/cproj
     (Running from Xcode instead? Set CPROJ_BIN in the scheme's environment.)
  4. Run. A box icon appears in the menu bar and no dock icon does.
  5. Click it. The debug view shows the SSD root, Docker, each project with its
     archetype and state, each service with `host → container` ports and its
     connection hint, the orphaned volumes, and the doctor findings.
  6. Compare against the terminal:
       cproj status --json
     Same projects, same ports, same states. That is the done-check.
MANUAL
printf '\033[32mDone-check passed the automated half.\033[0m\n'
