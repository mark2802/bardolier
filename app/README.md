# `app/` — the macOS menu-bar client

Empty until **Phase 5**. See `docs/implementation-plan.md`.

⚠️ **The Xcode project is created by the human, on the Mac.** Claude never
creates or edits `.xcodeproj`/`.pbxproj`, and never runs `xcodebuild`, the
Simulator, or code signing (`CLAUDE.md` § Environment boundary).

Phase 5 begins with the manual step: File → New → Project → macOS → App,
SwiftUI, saved here as `CprojBar`, with `LSUIElement` = YES and App Sandbox
**off**. After that, Claude writes `.swift` sources into this directory and the
human adds them to the target in Xcode.

The app is a **thin client**: it shells out to `cproj … --json` and renders the
result. No orchestration logic lives in Swift — if the app appears to need
logic, a CLI command grows to provide it.
