#!/usr/bin/env bash
# Phase 5 done-check — "the app launches in the menu bar and shows correctly
# decoded projects/services/ports". The build, the launch and the click are
# Xcode's, on the Mac (CLAUDE.md § Environment boundary); the script prints that
# checklist and runs nothing host-only.
#
# What a terminal can check: the Swift models against the frozen schemas in both
# directions (test/app-models.test.ts), the sources sitting where the
# synchronized folder group picks them up, and the two build settings Xcode does
# not default to (LSUIElement on, App Sandbox off), read back from the pbxproj.
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

ok()   { pass=$((pass + 1)); if [ -n "${VERBOSE:-}" ]; then printf '  \033[32m✓\033[0m %s\n' "$1"; fi; }
bad()  { printf '  \033[31m✗\033[0m %s\n' "$1"; fail=$((fail + 1)); }
todo() { printf '  \033[33m⚠\033[0m %s\n' "$1"; manual=$((manual + 1)); }
head() { printf '\n\033[1m%s\033[0m\n' "$1"; }

# ── 1. The client layer exists where the target will find it ─────────────────
head "1. Sources (app-spec.md §4)"

for file in \
  "$APP/Bardolier/BardolierModels.swift" \
  "$APP/Bardolier/BardolierError.swift" \
  "$APP/Bardolier/BardolierExecutable.swift" \
  "$APP/Bardolier/BardolierClient.swift" \
  "$APP/BardolierStore.swift" \
  "$APP/DebugStatusView.swift" \
  "$APP/BardolierApp.swift"
do
  [ -f "$file" ] && ok "$file" || bad "$file is missing"
done

if grep -q "fileSystemSynchronizedGroups" "$PBXPROJ"; then
  ok "the target uses a synchronized folder group — new files are in the build already"
else
  todo "the target has no synchronized folder group: add the new .swift files to it in Xcode"
fi

if grep -q "MenuBarExtra" "$APP/BardolierApp.swift"; then
  ok "the scene is a MenuBarExtra (app-spec.md §1)"
else
  bad "BardolierApp.swift declares no MenuBarExtra"
fi

# ── 2. Build settings the spec requires (the human's manual step) ────────────
head "2. Build settings (app-spec.md §1)"

if grep -q "ENABLE_APP_SANDBOX = NO" "$PBXPROJ"; then
  ok "App Sandbox is off — the app can shell out to bardolier"
else
  todo "App Sandbox is still ON. Xcode → target → Signing & Capabilities → remove App Sandbox."
  todo "  Until then every bardolier call fails: a sandboxed app may not exec a helper it doesn't ship."
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

# The ladder is walked ONCE, in order, by test/regression.sh (see its header).
# Recursing here — each check re-running all its predecessors, which did the
# same — made phase 0 come up dozens of times per invocation and turned this
# section into most of the run.
if [ -n "${BARDOLIER_REGRESSION:-}" ]; then
  ok "phases 0-4: already being walked, in order, by test/regression.sh"
else
  LADDER="$(mktemp)"
  if bash test/regression.sh --through 4 >"$LADDER" 2>&1; then
    ok "phases 0-4 still pass (test/regression.sh)"
  else
    bad "an earlier phase regressed — from test/regression.sh:"
    grep -m 6 '✗' "$LADDER" | sed 's/^/      /'
  fi
  rm -f "$LADDER"
fi

# ── Summary ──────────────────────────────────────────────────────────────────
printf '\n\033[1mPhase 5: %d passed, %d failed, %d manual\033[0m\n' "$pass" "$fail" "$manual"
[ "$fail" -eq 0 ] || exit 1

cat <<'MANUAL'

The half a terminal cannot check — on the Mac, in Xcode:

  1. Fix anything marked ⚠ above (App Sandbox off, LSUIElement YES).
  2. ⌘B. The synchronized folder group means the new files are already in the
     target; confirm they compiled.
  3. Make `bardolier` reachable from a GUI app — a Finder-launched app inherits no
     shell PATH. Either point the app straight at this working copy:
       defaults write com.mw.bardolier BardolierPath "$PWD/cli/bin/bardolier.js"
     or install it once and let the search find it:
       ln -s "$PWD/cli/bin/bardolier.js" /usr/local/bin/bardolier
     (Running from Xcode instead? Set BDLR_BIN in the scheme's environment.)
  4. Run. A box icon appears in the menu bar and no dock icon does.
  5. Click it. The debug view shows the SSD root, Docker, each project with its
     archetype and state, each service with `host → container` ports and its
     connection hint, the orphaned volumes, and the doctor findings.
  6. Compare against the terminal:
       bardolier status --json
     Same projects, same ports, same states. That is the done-check.
MANUAL
printf '\033[32mDone-check passed the automated half.\033[0m\n'
