# Phase 14 — root shell

**Goal:** A way to get a root shell in a running dev container for one-off
experimentation (installing a package to see what it needs before formalising
it as `extra_packages`, poking at something broken) — without `sudo` in any
base image and without a new project type. `docker exec -u root` already works
against any container regardless of the image's own `USER`; this phase is
`bardolier` naming that invocation and the app surfacing it.

**Deliverables:**
- `cli/src/commands/shell.ts`: `runShell(ctx, name, { root })`. When `root` is
  true, `exec` becomes `['docker', 'exec', '-u', 'root', '-it', container,
  'bash']` — same container, same `PROJECT_STOPPED`/`DOCKER_UNAVAILABLE`
  checks, one argv difference. `ShellOutput`'s shape is unchanged (still just
  `{ project, container, exec, workdir }`), so no schema bump.
  `renderShell`/`renderShellPrint` need no change — the argv already speaks
  for itself.
- `cli/src/commands/registry.ts`: `shell <name> [--print] [--root]`.
- `cli-spec.md` §6 (Shell): document `--root` and that it is ephemeral —
  nothing installed while root survives a `down` any more than any other
  runtime change, per `docs/development/phases/13-extra-packages.md`'s reasoning. Anything
  meant to persist belongs in `extra_packages`, not this shell.
- App — `BardolierClient.shell(project:root:)` appends `--root` when asked, same
  pattern as every other flag it appends itself (`CLAUDE.md`: no caller may
  append `--json`; this is the same seam for `--root`).
- App — `Shell/OptionKeyObserver.swift` (new): a small `ObservableObject`
  wrapping `NSEvent.addLocalMonitorForEvents(matching: .flagsChanged)`,
  publishing whether Option is currently held. Scoped to while the menu is
  open (started/stopped with it, not a permanent global monitor).
- App — `MenuBarRootView.swift`'s running-project row: while Option is held,
  "Open shell" swaps to "Open root shell" (title + a different `systemImage`,
  e.g. `terminal.fill`) and calls `store.openShell(project:root: true)`
  instead of the plain call. Same idiom as Finder's Option-held Secure Empty
  Trash — the common case's menu says nothing about this, the option is there
  for whoever holds the key.
- **Needs an early Xcode check, not just a type-check**: SwiftUI's
  `MenuBarExtra` menu items are real `NSMenuItem`s, and AppKit's native
  "alternate item revealed by a held modifier" mechanism
  (`NSMenuItem.isAlternate`/`keyEquivalentModifierMask`) isn't exposed through
  SwiftUI — this reimplements the same effect with a local event monitor and
  a state swap instead. Local monitors are widely reported to still fire
  during menu tracking, but I cannot run the app to confirm it visually
  reacts inside a live `MenuBarExtra` menu (environment boundary, CLAUDE.md).
  If it doesn't render/react cleanly, the fallback is the always-visible
  second row ("Open root shell" next to "Open shell") discussed and set
  aside in favour of this approach.

**Non-goals:** no confirmation dialog before opening a root shell — it isn't
destructive by itself, only what's typed in it can be; no persisted record
that a root shell was ever opened; no equivalent for `bardolier shell --print`'s
human-mode framing beyond documenting the flag; no change to `BardolierTerminal`,
which still just runs the returned argv verbatim.

**Done-check:** CLI-only (the app side is Xcode-verified by hand, per the
environment boundary): on a temp SSD, `shell <running-project> --root --json`
returns `exec` containing `-u root` ahead of `-it`; `--root --print` prints
the same command; a stopped project still fails `PROJECT_STOPPED` with
`--root`; plain `shell` (no flag) is byte-identical to today's output. Add to
`test/phase14-done-check.sh` plus a section in `test/regression.sh`
(`LAST=14`); no new unit test file needed beyond extending `test/phase4.test.ts`
(where `shell` was first covered) with the `--root` case.
