# `app/` — the macOS menu-bar client

The Xcode project is `Bardolier/Bardolier.xcodeproj`, created by the human
on the Mac in Phase 5. Claude writes `.swift` sources into
`Bardolier/Bardolier/` and never touches `.xcodeproj`/`.pbxproj`, never runs
`xcodebuild`, the Simulator, or a signing step (`CLAUDE.md` § Environment
boundary).

The target uses an Xcode 16+ **file-system-synchronized group**, so a `.swift`
file written into `Bardolier/Bardolier/` is in the build already — the
"Add Files to target…" step is a no-op here. Confirm
with ⌘B; that is all it takes.

## Layout

```
Bardolier/Bardolier/
  BardolierApp.swift       MenuBarExtra scene — the whole app
  BardolierStore.swift     the last answer the CLI gave, and the one place an
                           action runs (one at a time, refresh after each)
  DebugStatusView.swift    the decoded status, dumped — now behind "Diagnostics…"
  Bardolier/
    BardolierClient.swift     process exec, --json, error envelope → BardolierFailure
    BardolierModels.swift     Codable mirrors of cli/schema/*.json
    BardolierError.swift      stable codes (§2) → short human messages (§13)
    BardolierExecutable.swift finding bardolier, and a PATH its children can work in
  Preferences/
    AppPreferences.swift   the ONE setting that is the app's (auto-open shell);
                           SSD path and terminal live in the CLI config (§12)
  Shell/
    BardolierTerminal.swift  runs `bardolier shell`'s argv in the chosen terminal
  Views/
    MenuChrome.swift       rows, banners, confirmations, holder list — shapes
    MenuBarRootView.swift  the menu of app-spec.md §5, and its panels
    ServicesPanel.swift    §6 — catalogue with the attached rows ticked
    NewProjectPanel.swift  §8
    ReclaimPanel.swift     §9
    EjectPanel.swift       §10 — close all & eject, holders, Retry
    PreferencesPanel.swift §12
    FirstRunPanel.swift    §13 — shown instead of the menu when bardolier is missing
```

## Three build settings the template does not default to

All three are the human's, in Xcode, and the done-checks report whether they
have been done (`test/phase5-done-check.sh`, `test/phase6-done-check.sh`,
`test/phase7-done-check.sh`):

- **App Sandbox OFF** (target → Signing & Capabilities → remove the capability).
  The app's only ability is to run `bardolier`; a sandboxed app cannot exec a helper
  it does not ship, so every call fails until this is off. v1 is a local dev
  tool, so this is fine (`app-spec.md` §1).
- **`LSUIElement` = YES** (target → Info → "Application is agent (UIElement)"),
  so there is a menu-bar item and no dock icon.
- **`NSAppleEventsUsageDescription`** (target → Info → "Privacy - AppleEvents
  Sending Usage Description", e.g. "Bardolier opens a shell in your
  terminal."). Opening a shell drives Terminal or iTerm with Apple events
  (`app-spec.md` §7); without the string macOS **terminates the app** rather
  than asking for permission, the first time you use Open shell.

## Making `bardolier` reachable

A Finder-launched app inherits almost no `PATH`, so the client searches the
conventional install directories itself and hands the child a `PATH` good enough
to find `node`, `docker`, `lsof` and `diskutil` (see `BardolierExecutable.swift`).
Point it at a working copy with either:

```sh
defaults write com.mw.bardolier BardolierPath "$PWD/cli/bin/bardolier.js"
ln -s "$PWD/cli/bin/bardolier.js" /usr/local/bin/bardolier   # or install it properly
```

`BDLR_BIN` in an Xcode scheme's environment overrides both.

## Running it without Xcode

There is no installer yet, and the two halves come apart differently.

**The CLI** needs one symlink onto a directory `BardolierExecutable` already
searches. `/opt/homebrew/bin` is first in that list on Apple silicon, and it is
also npm's global prefix, so this is both what a shell finds and what the app
finds:

```sh
ln -sf "$PWD/cli/bin/bardolier.js" /opt/homebrew/bin/bardolier
```

A symlink rather than a copy on purpose: `bardolier` runs straight from
`cli/src/*.ts` with no build step, so the link stays correct after every edit.
Node resolves the symlink before resolving `../src/main.ts` and `node_modules`,
so nothing about the working copy has to move. Check it the way the app will,
with almost no environment:

```sh
env -i PATH=/opt/homebrew/bin:/usr/bin:/bin HOME="$HOME" bardolier doctor
```

**The app** still has to be built once — Xcode is host-only (`CLAUDE.md`). After
a ⌘B, drag `Bardolier.app` out of DerivedData into `/Applications`; the copy
is self-contained and finds `bardolier` on its own through the search above, with no
`BDLR_BIN` and no `BardolierPath` preference. Rebuild and re-copy when the Swift
changes. Nothing in the app needs the working copy at runtime.

The gap this leaves is real and deliberate: a proper `.app` bundle with a signed,
notarised installer, and a `bardolier` installed independently of a git checkout, is
its own piece of work.

## The rule this directory exists under

The app is a **thin client**: it shells out to `bardolier … --json` and renders the
result. No orchestration logic lives in Swift — if the app appears to need
logic, a CLI command grows to provide it — which is exactly what Phase 6 did:
the Services submenu and the New-project window needed the catalogue, and
Preferences needed to write the config, so `bardolier catalogue` and
`bardolier config get|set` exist rather than a copy of `services.yml` and a YAML
writer in Swift.

`test/app-models.test.ts` holds the Swift models to the frozen schemas in both
directions, asserts nothing here spawns anything but `bardolier`, and asserts the
app composes no connection string, no project path and no config file of its
own. `test/phase7.test.ts` adds the two flows that leave the app: a blocked
eject keeps its holders on screen for a Retry instead of reducing them to a
banner, nothing in Swift can force an unmount or kill a holder, the auto-shell
preference reaches `up`, and a missing `bardolier` is a first-run state rather than
one failed command.
