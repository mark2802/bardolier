#!/usr/bin/env bash
# Phase 7 done-check — "drive everything from the menu bar and safely eject;
# with Xcode running, eject is blocked and reported". The soak needs a real SSD
# and a real Xcode, and is printed at the end.
#
# Checks both flows' CLI side for real against a temp mount — `shell` resolves
# to argv and spawns nothing; `eject` stops first, refuses second, carries the
# holders the menu renders, and succeeds once the holder quits, which is exactly
# what Retry does — plus the Phase 7 app properties (test/phase7.test.ts), the
# build settings, and a type-check/SF Symbol pass when a Swift toolchain is
# present (same caveat as phase 6's header).
#
#   bash test/phase7-done-check.sh
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO"

APP="app/claude-yard/claude-yard"
PBXPROJ="app/claude-yard/claude-yard.xcodeproj/project.pbxproj"
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
export BARDOLIER_SSD_VOLUME="$VOLUME"
export BARDOLIER_SSD_ROOT="$MOUNTED"

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

# ── 1. Shell-open: the CLI resolves, the app runs (app-spec.md §7) ────────────
head "1. Shell-open resolves to argv the app can run (§7)"

$BARDOLIER new alpha --archetype web >/dev/null || bad "new exited non-zero"

if OUT="$($BARDOLIER shell alpha --json 2>&1)"; then
  bad "shell answered for a stopped project"
else
  if json_assert "$OUT" "d.error.code === 'PROJECT_STOPPED'"; then
    ok "a stopped project is PROJECT_STOPPED — the app relays it, never auto-starts"
  else
    bad "shell failed with the wrong code: $OUT"
  fi
fi

# The running case needs a container; the contract tests cover it against a
# stub. Here we only assert the shape the app depends on is documented.
if [ -f cli/schema/shell.schema.json ] && node -e "
  const s = require('./cli/schema/shell.schema.json')
  process.exit(s.required.includes('exec') && s.properties.exec.type === 'array' ? 0 : 1)
"; then
  ok "shell's contract is argv, so the app quotes once and spawns the terminal, not docker"
else
  bad "shell.schema.json no longer promises an argv array"
fi

# ── 2. Eject: stop, ask, refuse — never force (§10) ───────────────────────────
head "2. Close all & eject (§10)"

# A real `diskutil` must not be reached from a done-check, so the flow is
# driven through the same seam the app uses (cli/src/context.ts) with a
# scripted device — the holder path is what the menu renders.
if node --input-type=module -e "
  import assert from 'node:assert/strict'
  import { runEject } from './cli/src/commands/ssd.ts'
  import { createContext } from './cli/src/context.ts'
  import { BardolierError } from './cli/src/errors.ts'

  const volume = process.env.BARDOLIER_SSD_VOLUME
  let holders = [{ pid: 431, command: 'Xcode', user: 'mark', paths: [volume + '/alpha'] }]
  const ejected = []
  const ctx = createContext({
    path: process.env.BARDOLIER_CONFIG,
    env: { BARDOLIER_SSD_VOLUME: volume, BARDOLIER_SSD_ROOT: process.env.BARDOLIER_SSD_ROOT },
    docker: {
      available: async () => false,
      runningContainers: async () => [],
      removeContainer: async () => {},
    },
    device: {
      holders: async () => holders,
      // Not under test here (see test/phase10-done-check.sh) — this temp dir
      // stands in for a removable SSD, same fiction as every other check.
      removable: async () => true,
      eject: async (mount) => { if (holders.length) throw new Error('forced!'); ejected.push(mount) },
    },
    confirm: async () => { throw new Error('unexpected prompt') },
  })

  await assert.rejects(() => runEject(ctx), (error) => {
    assert.ok(error instanceof BardolierError)
    assert.equal(error.code, 'EJECT_BLOCKED')
    assert.deepEqual(error.details.holders.map((h) => h.command), ['Xcode'])
    return true
  })
  assert.deepEqual(ejected, [], 'a blocked eject unmounted anyway')

  // The user quits Xcode and clicks Retry: the same call, nothing else reset.
  holders = []
  const output = await runEject(ctx)
  assert.equal(output.ejected, true)
  assert.deepEqual(ejected, [volume])
" 2>"$TMP/eject.log"; then
  ok "a held volume is EJECT_BLOCKED with holders named, and Retry ejects once it quits"
else
  bad "the eject flow the panel drives is broken:"
  sed 's/^/      /' "$TMP/eject.log" | head -5
fi

if grep -qE "'--force'|\"--force\"" cli/src/commands/ssd.ts; then
  bad "eject grew a force flag — the menu must have nothing to reach for"
else
  ok "there is no way to force an unmount, in the CLI or above it"
fi

STATUS="$($BARDOLIER status --json)"
if schema_assert status "$STATUS"; then ok "status --json still matches status.schema.json"; else bad "status --json"; fi

# The ejected icon state (§11) is derived from status, so status has to keep
# answering with the disk gone. It must never fail.
export BARDOLIER_SSD_VOLUME="$TMP/gone"
export BARDOLIER_SSD_ROOT="$TMP/gone/claude-projects"
if GONE="$($BARDOLIER status --json)" && json_assert "$GONE" "d.ssd.mounted === false && Array.isArray(d.projects)"; then
  ok "with the disk gone status still answers — what the ejected icon reads (§11)"
else
  bad "status failed once the SSD was unmounted"
fi
export BARDOLIER_SSD_VOLUME="$VOLUME"
export BARDOLIER_SSD_ROOT="$MOUNTED"

# ── 3. Sources (§7, §10, §13) ─────────────────────────────────────────────────
head "3. Sources"

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

if grep -qE "INFOPLIST_KEY_NSAppleEventsUsageDescription = (YES|NO|\"\");?$" "$PBXPROJ"; then
  todo "NSAppleEventsUsageDescription is a boolean, not the sentence macOS shows. Set it to e.g."
  todo "  \"claude-yard opens a shell in your terminal.\""
elif grep -q "INFOPLIST_KEY_NSAppleEventsUsageDescription" "$PBXPROJ"; then
  ok "NSAppleEventsUsageDescription is a real sentence — shell-open can ask for permission"
else
  todo "NSAppleEventsUsageDescription is not set: macOS terminates the app the first time it"
  todo "  drives a terminal. Xcode → target → Info → \"Privacy - AppleEvents Sending Usage Description\"."
fi

# ── 5. Contract (test/) ───────────────────────────────────────────────────────
head "5. Contract"

if npm test >/dev/null 2>&1; then ok "npm test — including test/phase7.test.ts"; else bad "npm test"; fi
if npm run typecheck >/dev/null 2>&1; then ok "npm run typecheck"; else bad "npm run typecheck"; fi

# ── 6. Swift, when a toolchain is here (no build, no signing) ─────────────────
head "6. Swift sources (skipped without a toolchain)"

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

# ── 7. Earlier phases ─────────────────────────────────────────────────────────
head "7. Earlier phases"

# The ladder is walked ONCE, in order, by test/regression.sh (see its header).
# Recursing here — each check re-running all its predecessors, which did the
# same — made phase 0 come up dozens of times per invocation and turned this
# section into most of the run.
if [ -n "${BARDOLIER_REGRESSION:-}" ]; then
  ok "phases 0-6: already being walked, in order, by test/regression.sh"
else
  LADDER="$(mktemp)"
  if bash test/regression.sh --through 6 >"$LADDER" 2>&1; then
    ok "phases 0-6 still pass (test/regression.sh)"
  else
    bad "an earlier phase regressed — from test/regression.sh:"
    grep -m 6 '✗' "$LADDER" | sed 's/^/      /'
  fi
  rm -f "$LADDER"
fi

# ── Summary ───────────────────────────────────────────────────────────────────
printf '\n\033[1mPhase 7: %d passed, %d failed, %d manual\033[0m\n' "$pass" "$fail" "$manual"
[ "$fail" -eq 0 ] || exit 1

cat <<'MANUAL'

The half a terminal cannot check — the soak, with a real disk and a real Xcode:

  0. Fix anything marked ⚠ above, then ⌘B and run.
  1. FIRST RUN. Quit the app, `mv $(which bardolier) /tmp/bardolier-away`, relaunch. The
     menu says it can't find bardolier, lists where it looked, and offers a path
     field and Look again. Nothing else is offered, because nothing else works.
     Move it back, click Look again: the menu fills in without a relaunch.
  2. SHELL. Start a project (the item reads "Start & open shell"). A terminal
     window opens inside the dev container, in your own shell profile. Turn the
     preference off in Preferences: the item reads "Start" and starting opens
     nothing. "Open shell" on a running project still does.
  3. THE OTHER TERMINAL. Preferences → pick iTerm (or Ghostty). Open shell again:
     iTerm is driven directly; Ghostty gets a .command file and the menu says so.
     First time, macOS asks for Automation permission — that dialog is the
     NSAppleEventsUsageDescription string. Deny it once on purpose: the shell
     still opens through the .command fallback and the notice says how to grant
     it. (`tccutil reset AppleEvents com.mw.claude-yard` to be asked again.)
  4. PORTS. Expand a running project: click a service row — the connection
     string is on the clipboard; paste it into a GUI client and connect. It is
     copyable while the project runs, which is the only time it is useful.
  5. EJECT, BLOCKED. Open Xcode on something under the SSD. Menu → Close all &
     eject → Close all & eject. Every project stops, then the panel says
     "Xcode … still holds the SSD — quit them" and lists pid and path. The disk
     is STILL MOUNTED — check in Finder. Close the menu and reopen it: the row
     reads "Eject blocked — 1 holder…" and the panel still has the list.
  6. EJECT, CLEAN. Quit Xcode. Retry. The panel says safe to unplug, the menu-bar
     icon changes to the eject state, and the disk is gone from Finder.
  7. BACK. Plug it in. Reopen the menu: the icon and the status line go back to
     mounted, and the eject row reads "Close all & eject" again.
  8. Cross-check any point of it from the terminal:
       bardolier status --json
     Same projects, same ports, same states. That is the done-check.
MANUAL
printf '\033[32mDone-check passed the automated half.\033[0m\n'
