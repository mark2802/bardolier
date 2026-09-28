#!/usr/bin/env bash
# The menu-bar app, read as text: the sources exist where the target looks for
# them, the build settings the spec requires are set, the CLI surface the menu
# needs answers, and Swift type-checks where a toolchain is present.
#
#   bash test/app-done-check.sh
#   BARDOLIER_SKIP_DOCKER=1 …    offline assertions only
#   VERBOSE=1 …                  print every passing line
set -uo pipefail

source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
sandbox

APP="app/bardolier/bardolier"
PBXPROJ="app/bardolier/bardolier.xcodeproj/project.pbxproj"

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

# ── 2. The commands Phase 6 grew (cli-spec.md §1, §4.1, §8) ───────────────────
head "2. The CLI surface the menu needs"

CATALOGUE="$($BARDOLIER catalogue --json)"
if schema_assert catalogue "$CATALOGUE"; then ok "catalogue --json matches catalogue.schema.json"; else bad "catalogue --json"; fi
if json_assert "$CATALOGUE" "d.services.length > 0 && d.services.every(s => s.key && s.display && s.image && s.host_port_base)"; then
  ok "it lists every catalogue service with its image and band"
else
  bad "catalogue listed nothing usable"
fi
if json_assert "$CATALOGUE" "d.services.every(s => !('host_port' in s))"; then
  ok "and no assigned port — a band start is not an allocation (§5)"
else
  bad "catalogue reported an assigned host port"
fi
if json_assert "$CATALOGUE" "['config','ssd','bundled'].includes(d.origin) && typeof d.path === 'string'"; then
  ok "it names the services.yml that actually answered (§4.1)"
else
  bad "catalogue did not report its origin"
fi

GET="$($BARDOLIER config get --json)"
if schema_assert config-get "$GET"; then ok "config get --json matches config-get.schema.json"; else bad "config get --json"; fi
if json_assert "$GET" "d.exists === false && d.config.terminal === 'Terminal'"; then
  ok "an absent config file is an answer, not a failure (first run)"
else
  bad "config get mishandled a missing file"
fi

# `roots` moved to its own `root add|remove` surface (phase 18) — `config
# set` now covers only the two scalar keys, `catalogue_path` and `terminal`.
CATALOGUE_PATH="$TMP/services.yml"
SET="$($BARDOLIER config set catalogue_path "$CATALOGUE_PATH" --json)"
if schema_assert config-set "$SET"; then ok "config set --json matches config-set.schema.json"; else bad "config set --json"; fi
if CATALOGUE_PATH="$CATALOGUE_PATH" json_assert "$SET" "d.created === true && d.changed.includes('catalogue_path') && d.config.catalogue_path === process.env.CATALOGUE_PATH"; then
  ok "it wrote the key and reported the config after"
else
  bad "config set did not record the change"
fi
# Clear it again — a catalogue_path pointing at a file that doesn't exist is
# CONFIG_INVALID, and later sections need the bundled catalogue.
$BARDOLIER config set catalogue_path "" --json >/dev/null

$BARDOLIER config set terminal iTerm --json >/dev/null
AGAIN="$($BARDOLIER config set terminal iTerm --json)"
if json_assert "$AGAIN" "d.changed.length === 0 && d.created === false"; then
  ok "writing the same value again is a no-op"
else
  bad "a repeat write reported a change"
fi

if OUT="$($BARDOLIER config set nonsense x --json 2>&1)"; then
  bad "config set accepted an unknown key"
else
  if json_assert "$OUT" "d.error.code === 'INVALID_ARGUMENT'"; then
    ok "an unknown key fails INVALID_ARGUMENT with the settable keys named"
  else
    bad "config set failed with the wrong code"
  fi
fi

# ── 3. status.dir — "Open folder in Finder" without composing a path (§5) ─────
head "3. status carries each project's directory"

$BARDOLIER new alpha --archetype web --services postgres >/dev/null || bad "new exited non-zero"
STATUS="$($BARDOLIER status --json)"
if schema_assert status "$STATUS"; then ok "status --json still matches status.schema.json"; else bad "status --json"; fi
if MOUNTED="$MOUNTED" json_assert "$STATUS" "d.projects[0].dir === process.env.MOUNTED + '/alpha'"; then
  ok "the project reports its own dir, so the app never composes one"
else
  bad "status did not report the project dir"
fi
if json_assert "$STATUS" "d.projects[0].services[0].host_port >= 5432 && !!d.projects[0].services[0].connection_hint"; then
  ok "and the host port and connection hint the menu shows come with it"
else
  bad "status lost the service port"
fi

# The clone panel (§8.1) is a client of a contract that has not moved.
CLONE="$($BARDOLIER clone alpha beta --json)" || bad "clone exited non-zero"
if schema_assert clone "$CLONE"; then ok "clone --json matches clone.schema.json"; else bad "clone --json"; fi
if json_assert "$CLONE" 'd.source === "alpha" && d.with_content === false && d.bytes_copied === 0 && d.services.length === 1'; then
  ok "a shape clone reports its source and carries the service over"
else
  bad "clone did not report what the panel renders"
fi
ALPHA_PG="$(manifest_field alpha 'm.services.postgres.host_port')"
BETA_PG="$(manifest_field beta 'm.services.postgres.host_port')"
if [ -n "$BETA_PG" ] && [ "$ALPHA_PG" != "$BETA_PG" ]; then
  ok "the clone got its own host port, which is what the notice names"
else
  bad "the clone shares a host port with its source"
fi

# The move panel (§8.2) needs somewhere to move TO — switch to a config file
# with two named roots, the same way lifecycle-done-check's own move section
# does. HOME is faked only for the switch, then restored.
if docker_ready; then
  ORIGINAL_HOME="$HOME"
  unset BARDOLIER_ROOT
  mkdir -p "$TMP/home-move"
  export HOME="$TMP/home-move"

  $BARDOLIER root add "$MOUNTED" --name a --json >/dev/null || bad "root add a exited non-zero"
  DEFAULT_NAME="$(json_value "$($BARDOLIER root list --json)" "d.roots[0].name")"
  if [ "$DEFAULT_NAME" != "a" ]; then
    $BARDOLIER root remove "$DEFAULT_NAME" --json >/dev/null || bad "root remove of the materialised default exited non-zero"
  fi
  ROOT_B="$TMP/ssd2/claude-projects"
  mkdir -p "$ROOT_B"
  $BARDOLIER root add "$ROOT_B" --name b --json >/dev/null || bad "root add b exited non-zero"
  export HOME="$ORIGINAL_HOME"

  MOVE="$($BARDOLIER move alpha --root b --json)" || bad "move exited non-zero"
  if schema_assert move "$MOVE"; then ok "move --json matches move.schema.json"; else bad "move --json"; fi
  if json_assert "$MOVE" 'd.moved === true && d.to.root === "b"'; then
    ok "the move panel's contract lands the project on the chosen root"
  else
    bad "move did not report what the panel renders"
  fi
fi

# ── 4. Sources (app-spec.md §5-§13) ───────────────────────────────────────────
head "4. Sources"

for file in \
  "$APP/Bardolier/BardolierModels.swift" \
  "$APP/Bardolier/BardolierError.swift" \
  "$APP/Bardolier/BardolierExecutable.swift" \
  "$APP/Bardolier/BardolierClient.swift" \
  "$APP/BardolierStore.swift" \
  "$APP/Preferences/AppPreferences.swift" \
  "$APP/Shell/BardolierTerminal.swift" \
  "$APP/Views/MenuChrome.swift" \
  "$APP/Views/MenuBarRootView.swift" \
  "$APP/Views/ServicesPanel.swift" \
  "$APP/Views/NewProjectPanel.swift" \
  "$APP/Views/ClonePanel.swift" \
  "$APP/Views/MovePanel.swift" \
  "$APP/Views/ReclaimPanel.swift" \
  "$APP/Views/PreferencesPanel.swift" \
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

if grep -q "MenuBarRootView()" "$APP/BardolierApp.swift"; then
  ok "the MenuBarExtra shows the menu, not the Phase 5 debug dump"
else
  bad "BardolierApp.swift still hosts the debug view"
fi

# Clone in the menu (phase 25, §8.1).
if grep -q 'case clone(source: String)' "$APP/Views/MenuBarRootView.swift"; then
  ok "the panel carries the project it is for, like .services does"
else
  bad "MenuPanel has no .clone(source:) case"
fi
if grep -q 'title: "Clone…"' "$APP/Views/MenuBarRootView.swift"; then
  ok "the project submenu offers Clone…"
else
  bad "ProjectRow has no Clone… row"
fi
if grep -q 'contentBlockedReason' "$APP/Views/ClonePanel.swift"; then
  ok "a running source disables the copy checkbox with a reason, not silently (§11)"
else
  bad "ClonePanel disables --with-content without saying why"
fi
if grep -q 'store.clone(' "$APP/Views/ClonePanel.swift" && grep -q 'client.clone(' "$APP/BardolierStore.swift"; then
  ok "the panel goes through the store and the store through the client (§4)"
else
  bad "ClonePanel does not route its call through the store and client"
fi

# Move in the menu (phase 26, §8.2).
if grep -q 'case move(project: String)' "$APP/Views/MenuBarRootView.swift"; then
  ok "the panel carries the project it is for, like .clone does"
else
  bad "MenuPanel has no .move(project:) case"
fi
if grep -q 'title: "Move to…"' "$APP/Views/MenuBarRootView.swift"; then
  ok "the project submenu offers Move to…"
else
  bad "ProjectRow has no Move to… row"
fi
if grep -q 'moveBlockedReason' "$APP/Views/MovePanel.swift"; then
  ok "a running project disables the move action with a reason, not silently (§11)"
else
  bad "MovePanel disables its action without saying why"
fi
if grep -q 'destinationRoots' "$APP/Views/MovePanel.swift" && grep -q 'sourceProject?.root' "$APP/Views/MovePanel.swift"; then
  ok "the root picker excludes the project's own root"
else
  bad "MovePanel does not filter out the project's own root"
fi
if grep -q 'store.move(' "$APP/Views/MovePanel.swift" && grep -q 'client.move(' "$APP/BardolierStore.swift"; then
  ok "the panel goes through the store and the store through the client (§4)"
else
  bad "MovePanel does not route its call through the store and client"
fi

# ── 5. Build settings (the human's manual step) ───────────────────────────────
head "5. Build settings (app-spec.md §1, §7)"

if grep -q "ENABLE_APP_SANDBOX = NO" "$PBXPROJ"; then
  ok "App Sandbox is off — the app can shell out to bardolier"
else
  todo "App Sandbox is still ON. Xcode → target → Signing & Capabilities → remove App Sandbox."
fi

if grep -q "INFOPLIST_KEY_LSUIElement = YES" "$PBXPROJ"; then
  ok "LSUIElement is YES — menu-bar only, no dock icon"
else
  todo "LSUIElement is not set. Xcode → target → Info → \"Application is agent (UIElement)\" = YES."
fi

# New in Phase 6: opening a shell drives Terminal/iTerm with Apple events.
# The key is a STRING — the sentence the permission dialog shows — so a bare
# YES/NO is a misconfiguration that reaches the user as a dialog reading "YES".
if grep -qE "INFOPLIST_KEY_NSAppleEventsUsageDescription = (YES|NO|\"\");?$" "$PBXPROJ"; then
  todo "NSAppleEventsUsageDescription is set to a boolean, not a sentence. Xcode → target → Info →"
  todo "  set \"Privacy - AppleEvents Sending Usage Description\" to e.g. \"bardolier opens a shell in your terminal.\""
  todo "  It is the text macOS shows when asking for permission; \"YES\" is what the user would read."
elif grep -q "INFOPLIST_KEY_NSAppleEventsUsageDescription" "$PBXPROJ"; then
  ok "NSAppleEventsUsageDescription is a real sentence — macOS can ask to allow shell-open"
else
  todo "NSAppleEventsUsageDescription is not set. Xcode → target → Info → add"
  todo "  \"Privacy - AppleEvents Sending Usage Description\" = \"bardolier opens a shell in your terminal.\""
  todo "  Without it macOS terminates the app instead of prompting, the first time you Open shell."
fi

# ── 6. Sources (§7, §10, §13) ─────────────────────────────────────────────────
head "6. Sources"

for file in \
  "$APP/Views/EjectPanel.swift" \
  "$APP/Views/FirstRunPanel.swift" \
  "$APP/Shell/BardolierTerminal.swift" \
  "$APP/Views/MenuChrome.swift" \
  "$APP/BardolierStore.swift"
do
  [ -f "$file" ] && ok "$file" || bad "$file is missing"
done

if grep -q "fileSystemSynchronizedGroups" "$PBXPROJ"; then
  ok "the target uses a synchronized folder group — the new panels are in the build already"
else
  todo "add EjectPanel.swift and FirstRunPanel.swift to the target in Xcode (⌘B to confirm)"
fi

# ── 7. Build settings (the human's manual step) ───────────────────────────────
head "7. Build settings (app-spec.md §1, §7)"

if grep -q "ENABLE_APP_SANDBOX = NO" "$PBXPROJ"; then
  ok "App Sandbox is off — the app can shell out to bardolier"
else
  todo "App Sandbox is still ON. Xcode → target → Signing & Capabilities → remove App Sandbox."
fi

if grep -q "INFOPLIST_KEY_LSUIElement = YES" "$PBXPROJ"; then
  ok "LSUIElement is YES — menu-bar only, no dock icon"
else
  todo "LSUIElement is not set. Xcode → target → Info → \"Application is agent (UIElement)\" = YES."
fi

if grep -qE "INFOPLIST_KEY_NSAppleEventsUsageDescription = (YES|NO|\"\");?$" "$PBXPROJ"; then
  todo "NSAppleEventsUsageDescription is a boolean, not the sentence macOS shows. Set it to e.g."
  todo "  \"bardolier opens a shell in your terminal.\""
elif grep -q "INFOPLIST_KEY_NSAppleEventsUsageDescription" "$PBXPROJ"; then
  ok "NSAppleEventsUsageDescription is a real sentence — shell-open can ask for permission"
else
  todo "NSAppleEventsUsageDescription is not set: macOS terminates the app the first time it"
  todo "  drives a terminal. Xcode → target → Info → \"Privacy - AppleEvents Sending Usage Description\"."
fi

# ── 8. Swift, when a toolchain is here (no build, no signing) ─────────────────
head "8. Swift sources (skipped without a toolchain)"

SDK="$(xcrun --show-sdk-path 2>/dev/null || true)"
if command -v swiftc >/dev/null 2>&1 && [ -n "$SDK" ]; then
  if swiftc -typecheck -swift-version 5 -default-isolation MainActor -strict-concurrency=complete \
      -enable-upcoming-feature MemberImportVisibility \
      -enable-upcoming-feature DisableOutwardActorInference \
      -enable-upcoming-feature GlobalActorIsolatedTypesUsability \
      -enable-upcoming-feature InferSendableFromCaptures \
      -enable-upcoming-feature NonisolatedNonsendingByDefault \
      -target arm64-apple-macos15.0 -sdk "$SDK" $(find "$APP" -name '*.swift') >"$TMP/swift.log" 2>&1; then
    ok "the app sources type-check (weaker than ⌘B — see phase6's header)"
  else
    bad "swiftc -typecheck failed:"
    grep "error:" "$TMP/swift.log" | head -5 | sed 's/^/      /'
  fi

  {
    grep -rhoE '(systemName|systemImage): *"[^"]+"' "$APP" | sed 's/.*"\(.*\)"/\1/'
    grep -rhoE 'return "[a-z][a-z0-9.]*"' "$APP" | sed 's/.*"\(.*\)"/\1/'
  } | sort -u > "$TMP/symbols.txt"

  cat > "$TMP/symcheck.swift" <<'SWIFT'
import AppKit
let names = try! String(contentsOfFile: CommandLine.arguments[1], encoding: .utf8)
    .split(separator: "\n").map(String.init)
var missing: [String] = []
for name in names where !name.isEmpty {
    if NSImage(systemSymbolName: name, accessibilityDescription: nil) == nil { missing.append(name) }
}
if missing.isEmpty { exit(0) }
print(missing.joined(separator: ", "))
exit(1)
SWIFT
  if swiftc -o "$TMP/symcheck" "$TMP/symcheck.swift" -sdk "$SDK" >/dev/null 2>&1; then
    if MISSING="$("$TMP/symcheck" "$TMP/symbols.txt")"; then
      ok "every SF Symbol the menu names resolves ($(wc -l < "$TMP/symbols.txt" | tr -d ' ') of them)"
    else
      bad "these symbols do not exist and would draw as nothing: $MISSING"
    fi
  else
    skip "couldn't build the symbol check"
  fi
else
  skip "no Swift toolchain here — Xcode will type-check on ⌘B (CLAUDE.md boundary)"
fi

# ── 9. The MANUAL prerequisite (the human, in Xcode) ────────────────────────────
head "9. MANUAL prerequisite (docs/development/phases/16-rename-app.md)"

PBXPROJ="app/bardolier/bardolier.xcodeproj/project.pbxproj"
SCHEME="app/bardolier/bardolier.xcodeproj/xcshareddata/xcschemes/bardolier.xcscheme"

if [ -d "app/bardolier/bardolier" ]; then
  ok "app/bardolier/bardolier exists — the outer directories are renamed"
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

# ── 10. The Swift files exist under their new names ────────────────────────────
head "10. Renamed Swift sources"

APP="app/bardolier/bardolier"
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

# ── Summary ───────────────────────────────────────────────────────────────────
summary "App"
