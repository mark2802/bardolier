#!/usr/bin/env bash
# Phase 6 done-check — "drive the whole lifecycle FROM THE MENU BAR". That is a
# human with a mouse, so this makes sure everything the mouse depends on is
# already true and prints the manual pass.
#
# Checks the CLI surface Phase 6 added (`catalogue`, `config get|set`, `dir` on
# every status project), the Swift sources' location, the build settings —
# including NSAppleEventsUsageDescription, without which macOS kills the app the
# first time it drives a terminal — and, when a Swift toolchain is present, a
# type-check plus an SF Symbol check (an unresolvable symbol draws as NOTHING,
# i.e. a blank menu-bar icon). That type-check only approximates the target's
# settings and is weaker than ⌘B: read a pass as "no obvious breakage".
#
#   bash test/phase6-done-check.sh
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO"

APP="app/bardolier/bardolier"
PBXPROJ="app/bardolier/bardolier.xcodeproj/project.pbxproj"
BARDOLIER="node cli/bin/bardolier.js"
pass=0
fail=0
manual=0

ok()   { pass=$((pass + 1)); if [ -n "${VERBOSE:-}" ]; then printf '  \033[32m✓\033[0m %s\n' "$1"; fi; }
bad()  { printf '  \033[31m✗\033[0m %s\n' "$1"; fail=$((fail + 1)); }
skip() { printf '  \033[33m–\033[0m %s\n' "$1"; }
todo() { printf '  \033[33m⚠\033[0m %s\n' "$1"; manual=$((manual + 1)); }
head() { printf '\n\033[1m%s\033[0m\n' "$1"; }

TMP="$(cd "$(mktemp -d)" && pwd -P)"
cleanup() { rm -rf "$TMP"; }
trap cleanup EXIT

VOLUME="$TMP/ssd"
MOUNTED="$VOLUME/claude-projects"
mkdir -p "$MOUNTED"

export BARDOLIER_CONFIG="$TMP/config.yml"
export BARDOLIER_ROOT="$MOUNTED"

json_assert() { # json_assert <json> <js body over `d`>
  node -e "
    const d = JSON.parse(process.argv[1])
    process.exit((${2}) ? 0 : 1)
  " "$1" 2>/dev/null
}

schema_assert() { # schema_assert <schema-name> <json>
  node --input-type=module -e "
    import { validate } from './cli/src/schema.ts'
    const { valid, errors } = validate(process.argv[1], JSON.parse(process.argv[2]))
    if (!valid) { console.error(errors.join('\n')); process.exit(1) }
  " "$1" "$2" 2>/dev/null
}

# ── 1. The commands Phase 6 grew (cli-spec.md §1, §4.1, §8) ───────────────────
head "1. The CLI surface the menu needs"

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

# ── 2. status.dir — "Open folder in Finder" without composing a path (§5) ─────
head "2. status carries each project's directory"

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

# ── 3. Sources (app-spec.md §5-§13) ───────────────────────────────────────────
head "3. Sources"

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

# ── 4. Build settings (the human's manual step) ───────────────────────────────
head "4. Build settings (app-spec.md §1, §7)"

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

# ── 5. Contract (test/) ───────────────────────────────────────────────────────
head "5. Contract"

if npm test >/dev/null 2>&1; then ok "npm test — models mirror the schemas, both directions"; else bad "npm test"; fi
if npm run typecheck >/dev/null 2>&1; then ok "npm run typecheck"; else bad "npm run typecheck"; fi

# ── 6. Swift, when a toolchain is here (no build, no signing) ─────────────────
head "6. Swift sources (skipped without a toolchain)"

SDK="$(xcrun --show-sdk-path 2>/dev/null || true)"
if command -v swiftc >/dev/null 2>&1 && [ -n "$SDK" ]; then
  # Flags chosen to approximate the target (SWIFT_VERSION 5.0,
  # SWIFT_DEFAULT_ACTOR_ISOLATION MainActor, SWIFT_APPROACHABLE_CONCURRENCY,
  # MemberImportVisibility, macOS 15). See the header: still weaker than ⌘B.
  if swiftc -typecheck -swift-version 5 -default-isolation MainActor -strict-concurrency=complete \
      -enable-upcoming-feature MemberImportVisibility \
      -enable-upcoming-feature DisableOutwardActorInference \
      -enable-upcoming-feature GlobalActorIsolatedTypesUsability \
      -enable-upcoming-feature InferSendableFromCaptures \
      -enable-upcoming-feature NonisolatedNonsendingByDefault \
      -target arm64-apple-macos15.0 -sdk "$SDK" $(find "$APP" -name '*.swift') >"$TMP/swift.log" 2>&1; then
    ok "the app sources type-check (weaker than ⌘B — see the header)"
  else
    bad "swiftc -typecheck failed:"
    grep "error:" "$TMP/swift.log" | head -5 | sed 's/^/      /'
  fi

  # Every SF Symbol the menu names, resolved the way AppKit will resolve it.
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

# ── 7. Earlier phases ─────────────────────────────────────────────────────────
head "7. Earlier phases"

# The ladder is walked ONCE, in order, by test/regression.sh (see its header).
# Recursing here — each check re-running all its predecessors, which did the
# same — made phase 0 come up dozens of times per invocation and turned this
# section into most of the run.
if [ -n "${BARDOLIER_REGRESSION:-}" ]; then
  ok "phases 0-5: already being walked, in order, by test/regression.sh"
else
  LADDER="$(mktemp)"
  if bash test/regression.sh --through 5 >"$LADDER" 2>&1; then
    ok "phases 0-5 still pass (test/regression.sh)"
  else
    bad "an earlier phase regressed — from test/regression.sh:"
    grep -m 6 '✗' "$LADDER" | sed 's/^/      /'
  fi
  rm -f "$LADDER"
fi

# ── Summary ───────────────────────────────────────────────────────────────────
printf '\n\033[1mPhase 6: %d passed, %d failed, %d manual\033[0m\n' "$pass" "$fail" "$manual"
[ "$fail" -eq 0 ] || exit 1

cat <<'MANUAL'

The half a terminal cannot check — the lifecycle FROM THE MENU BAR:

  0. Fix anything marked ⚠ above, then ⌘B and run. A box icon appears in the
     menu bar; no dock icon does.
  1. Preferences… → point "Volume" at your SSD and "Projects" at its projects
     dir, pick your terminal, leave "Starting a project opens a shell" on.
     Reopen the menu: the status line reads "SSD: mounted (…)".
  2. New project… → name it, pick web, tick postgres → Create. The banner names
     the host port it was assigned. The project appears, stopped.
  3. Expand it → Services… → every catalogue service is listed, postgres ticked
     with `host :<port> → :5432`. Click the copy icon; paste it somewhere.
  4. Back → Start. A terminal window opens inside the dev container (that is
     `bardolier shell`'s argv, run by the app). The dot goes green.
  5. While it is running, open Services… again: it says "Stop the project to
     change its services", and the rows are inert. That refusal is the CLI's,
     relayed — do not let the app work around it.
  6. Stop → Services… → click postgres to detach → confirm. The banner says the
     port is released and the volume kept.
  7. Reclaim disk… → the kept volume is listed with its size. Delete it, confirm.
  8. Delete… the project, confirm (leave the volumes box unticked). It is gone
     from the menu.
  9. Compare against the terminal at any point:
       bardolier status --json
     Same projects, same ports, same states. That is the done-check.
 10. Close all & eject is Phase 7's flow; clicking it here should either eject
     cleanly or report its holders — neither may force.
MANUAL
printf '\033[32mDone-check passed the automated half.\033[0m\n'
