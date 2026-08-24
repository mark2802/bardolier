# `app/` — the macOS menu-bar client

The Xcode project is `claude-yard/claude-yard.xcodeproj`, created by the human
on the Mac in Phase 5. Claude writes `.swift` sources into
`claude-yard/claude-yard/` and never touches `.xcodeproj`/`.pbxproj`, never runs
`xcodebuild`, the Simulator, or a signing step (`CLAUDE.md` § Environment
boundary).

The target uses an Xcode 16+ **file-system-synchronized group**, so a `.swift`
file written into `claude-yard/claude-yard/` is in the build already — the
"Add Files to target…" step in the implementation plan is a no-op here. Confirm
with ⌘B; that is all it takes.

## Layout

```
claude-yard/claude-yard/
  claude_yardApp.swift     MenuBarExtra scene — the whole app
  CprojStore.swift         the last answer the CLI gave, plus refresh/debounce
  DebugStatusView.swift    Phase 5's deliverable: the decoded status, dumped
  Cproj/
    CprojClient.swift      process exec, --json, error envelope → CprojFailure
    CprojModels.swift      Codable mirrors of cli/schema/*.json
    CprojError.swift       stable codes (§2) → short human messages (§13)
    CprojExecutable.swift  finding cproj, and a PATH its children can work in
```

## Two build settings the template does not default to

Both are the human's, in Xcode, and `test/phase5-done-check.sh` reports whether
they have been done:

- **App Sandbox OFF** (target → Signing & Capabilities → remove the capability).
  The app's only ability is to run `cproj`; a sandboxed app cannot exec a helper
  it does not ship, so every call fails until this is off. v1 is a local dev
  tool, so this is fine (`app-spec.md` §1).
- **`LSUIElement` = YES** (target → Info → "Application is agent (UIElement)"),
  so there is a menu-bar item and no dock icon.

## Making `cproj` reachable

A Finder-launched app inherits almost no `PATH`, so the client searches the
conventional install directories itself and hands the child a `PATH` good enough
to find `node`, `docker`, `lsof` and `diskutil` (see `CprojExecutable.swift`).
Point it at a working copy with either:

```sh
defaults write com.mw.claude-yard CprojPath "$PWD/cli/bin/cproj.js"
ln -s "$PWD/cli/bin/cproj.js" /usr/local/bin/cproj   # or install it properly
```

`CPROJ_BIN` in an Xcode scheme's environment overrides both.

## The rule this directory exists under

The app is a **thin client**: it shells out to `cproj … --json` and renders the
result. No orchestration logic lives in Swift — if the app appears to need
logic, a CLI command grows to provide it. `test/app-models.test.ts` holds the
Swift models to the frozen schemas in both directions and asserts nothing here
spawns anything but `cproj`.
