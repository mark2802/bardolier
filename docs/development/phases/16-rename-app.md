# Phase 16 — the rename: the app

**Goal:** Finish phase 15 on the Swift side, after the human has done the parts
of an Xcode rename that only Xcode can do.

**MANUAL, before this phase (the human, in Xcode).** `CLAUDE.md`'s environment
boundary applies: nothing here creates or edits `.xcodeproj`/`.pbxproj`.
- Rename the target, scheme and product to `<Name>`; set the bundle identifier.
- Rename `app/claude-yard/` and `app/claude-yard/claude-yard/` on disk and
  re-point the synchronized folder group.
- Fix the hard-coded `<owner's home>/claude-yard/cli/bin/cproj.js` path in the
  scheme (`xcshareddata/xcschemes/*.xcscheme`) — it is both stale after the
  rename and one of the three personal-path leaks phase 23 scrubs.
- Confirm the target still builds before handing back; a broken project file is
  not something this phase can diagnose from the CLI side.

**Deliverables:**
- Types and files under `Cproj/`: `CprojClient`, `CprojError`,
  `CprojExecutable`, `CprojModels`, plus `CprojStore`, `CprojTerminal`,
  `claude_yardApp.swift`. Type name and filename move together — the target
  uses a synchronized folder group, so renamed files build without an
  Add-Files step, but the *deletions* must be real deletions, not leftovers.
- `CprojExecutable`'s search: it looks for a binary named `cproj` in a fixed
  list of paths. Both the binary name and the list's rendering in
  `FirstRunPanel` (§13: a missing CLI is the state of the whole menu, and the
  panel names the paths actually searched) must say `<name>`.
- `Preferences/AppPreferences.swift`: `UserDefaults` keys. The bundle-identifier
  change already moves the defaults domain, so the human's local preferences
  reset once regardless — rename the keys rather than carrying `cproj`-prefixed
  strings into a fresh domain.
- User-visible strings across `Views/*` and `DebugStatusView.swift`: anywhere
  the menu, a panel, an error banner or a help string says `cproj` or
  `claude-yard`.
- `test/app-models.test.ts` in lockstep. It reads the Swift as text and is what
  catches a struct that was missed, a `Process` spawned outside the client, or
  a `CprojErrorCode` constant that no longer matches `errors.ts`.
- `docs/app-spec.md` — renamed by phase 15 already; re-read it here for
  sentences the mechanical pass got syntactically right and semantically wrong.

**Non-goals:** no UI change beyond the strings; no new app capability; no
`.xcodeproj` edits.

**Done-check:** `npm run test:quiet` (which includes `app-models.test.ts`)
green; a Swift type-check of the sources; and the same grep assertion phase 15
added, now with `app/` no longer excluded. The human confirms the app builds in
Xcode, launches, finds the renamed binary, and shows a project list — the
first-run panel naming `<name>` rather than `cproj` is the visible proof the
executable search was renamed too.
