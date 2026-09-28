# `app/` — the macOS menu-bar client

The Xcode project is `app/bardolier/bardolier.xcodeproj`, created by the human
on the Mac in Phase 5. Claude writes `.swift` sources into
`app/bardolier/bardolier/` and never touches `.xcodeproj`/`.pbxproj`, never
runs `xcodebuild`, the Simulator, or a signing step (`CLAUDE.md` §
Environment boundary) — with one exception: `npm run setup:app`
(`scripts/build-app.sh`) DOES run `xcodebuild`, but from the **host**, never
from inside the dev container Claude runs in.

The target uses an Xcode 16+ **file-system-synchronized group**, so a `.swift`
file written into `app/bardolier/bardolier/` is in the build already — the
"Add Files to target…" step is a no-op here. Confirm
with ⌘B; that is all it takes.

## Layout

```
app/bardolier/bardolier/
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

All three are the human's, in Xcode, and `test/app-done-check.sh` reports
whether they have been done:

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
`npm run setup` (`bardolier install`, phase 28) puts a symlink into the first
of those directories that exists and is writable — a working copy is reachable
without editing a shell profile or a `defaults write`.

For a working copy in an unusual place, or to point the app at one without
touching the search order at all: `--bin-dir` picks the directory explicitly
(`npm run setup -- --bin-dir /some/dir`, if it is already on your shell's own
PATH), or `BDLR_BIN` in an Xcode scheme's environment overrides the search
entirely — that is how the app is run from Xcode against a working copy — or
set the preference by hand:

```sh
defaults write com.mw.bardolier BardolierPath "$PWD/cli/bin/bardolier.js"
```

## Running it without Xcode

`npm run setup` puts `bardolier` (and `bdlr`) on a bin directory the app
already searches — `/opt/homebrew/bin` is first on Apple silicon, and it is
also npm's global prefix, so this is both what a shell finds and what the app
finds. It links rather than copies, on purpose: `bardolier` runs straight from
`cli/src/*.ts` with no build step, so the link stays correct after every edit,
including one made after `setup` already ran. Check it the way the app will,
with almost no environment:

```sh
npm run setup
env -i PATH=/opt/homebrew/bin:/usr/bin:/bin HOME="$HOME" bardolier doctor
```

**The app** still has to be built once — Xcode is host-only (`CLAUDE.md`).
`npm run setup:app` (`scripts/build-app.sh`) runs `xcodebuild` and drops
`Bardolier.app` straight into `/Applications`, unsigned (a locally built app
carries no quarantine flag, so this launches fine) — no Xcode window opened.
The equivalent by hand is a ⌘B followed by dragging `bardolier.app` out of
DerivedData into `/Applications`. Either way the copy is self-contained and
finds `bardolier` on its own through the search above, with no `BDLR_BIN` and
no `BardolierPath` preference. Rebuild and re-copy when the Swift changes —
nothing in the app needs the working copy at runtime.

The gap this leaves is real and deliberate: a Developer-ID-signed, notarised
`.dmg` release is its own piece of work, tracked separately from a clone
being able to build and run the app itself.

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
own. `test/eject.test.ts` and `test/shell.test.ts` add the two flows that
leave the app: a blocked
eject keeps its holders on screen for a Retry instead of reducing them to a
banner, nothing in Swift can force an unmount or kill a holder, the auto-shell
preference reaches `up`, and a missing `bardolier` is a first-run state rather than
one failed command.
