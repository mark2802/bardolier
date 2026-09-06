# App Spec — Menu-Bar Container Project Manager

Status: draft for implementation. macOS status-bar app; a **thin client** over
the `bardolier` CLI. Companion docs: `cli-spec.md` (the engine — authoritative for
all behaviour), `CLAUDE.md`, `../INTENT.md`.

**The CLI is the API; the app is a thin client.** The app shells out to `bardolier`,
parses `--json`, and renders. It contains no Docker/orchestration logic and holds
no persistent state beyond UI preferences.

---

## 1. Platform

- SwiftUI `MenuBarExtra`, macOS. Built as its own Xcode project — created and
  maintained by the human at the Mac; Claude writes `.swift` files into the
  synchronized folder group and never touches the project file (`app/README.md`).
- No sandbox entitlement that would block shelling out to `docker`/`bardolier`
  (the app runs a helper process; App Sandbox would need to be off or carefully
  configured — v1 targets a non-sandboxed local dev tool).

## 2. Responsibilities (v1)

Create, list, start, stop, delete projects; add/remove services; open a shell;
reclaim orphaned volumes; close-all + eject. Everything maps 1:1 to a CLI
command in `cli-spec.md` §6.

## 3. Non-goals (v1)

- No Docker GUI features beyond the above.
- No Kubernetes manifest generation.
- No in-app code editing or Claude invocation.
- No hot add/remove to a running project (CLI forbids it).

## 4. CLI integration

- A single `BardolierClient` type wraps process execution: builds argv, always passes
  `--json`, decodes into `Codable` models mirroring the CLI schemas, maps the
  `error.code` strings to a Swift error enum.
- On every menu open and after every mutating action, call `bardolier status --json`
  and re-render. Debounce so rapid reopens don't stack calls.
- Long operations (`up`, `down`, `eject`, `build`) run off the main thread with a
  progress indicator; conflicting actions disabled until completion.
- `bardolier doctor --json` on launch; if Docker down or SSD absent, reflect in the
  icon and disable inapplicable actions.

## 5. Menu structure

```
● SSD: mounted (/Volumes/ssd)          ← status line, non-interactive
────────────────────────────────
Projects
  ● myapp            ▸                  ← green=running / grey=stopped
      Stop
      Open shell
      Services…      ▸
      Open folder in Finder
      Delete…
  ○ otherapp         ▸
      Start
      Services…      ▸
      Open folder in Finder
      Delete…
────────────────────────────────
New project…
Reclaim disk…
Close all & eject
────────────────────────────────
Preferences…
Quit
```

- The status line reads "SSD: …" only when the default root is a removable
  volume; a root on the internal disk reads "Root: mounted (…)" / "Root not
  found: (…)" instead — a plain folder is never called an SSD, and "plug it
  in" is never offered for one (phase 18, `doctor`'s `ssd.roots[].removable`).
- Running project shows **Stop** + **Open shell**; stopped shows **Start**.
- **Start** brings the project up and, per preference (default ON), opens a shell
  (see §7). **Open shell** is always available for a running project.
- Each project item shows attached services with host ports in its submenu
  (click-to-copy connection string — the debugging payoff).

## 6. Services submenu (per project)

Lists every catalogue service with a checkmark if attached; each attached row
shows its host port and a copy-connection action.

- **Attach**: calls `bardolier service add`. If the project is running, the CLI
  returns `PROJECT_RUNNING`; the app shows "Stop the project to change services"
  rather than attempting it. (Both add and remove require stop/start.)
- **Detach**: calls `bardolier service remove`; the volume is kept and later appears
  in Reclaim disk. Confirm, naming the service.
- After any change, show the newly assigned host port.

## 7. Shell opening

- The CLI (`bardolier shell <name> --json`) returns the container name and the exec
  argv. The **app** launches the user's terminal running that command.
- Terminal choice is a **Preference** (Terminal.app default; iTerm, Ghostty,
  etc. optional). The app uses the configured terminal to run the exec command.
- When only a lesser route is available (macOS refusing the Automation
  permission), the app opens the shell anyway and says why in a banner that
  **survives refreshes** — opening the menu is a refresh, so an ordinary notice
  would be wiped before it could be read. The user dismisses it, or a shell that
  opens by the good route clears it.
- **Start auto-opens a shell by default** (preference-controlled) so single-project
  starts drop you straight in. When batch-starting (Close-all's inverse isn't a
  thing, but multi-start via repeated clicks), the preference lets the user avoid
  a stack of windows.

## 8. New project window

Small modal:
- **Name** — validated (no spaces; no collision; the app calls `list` to check).
- **Archetype** — web / iOS / Android / library.
- **Services** — checkbox list from the catalogue (from `bardolier status`/catalogue).
- **Create** → `bardolier new … --json`; on success the window closes and the menu
  refreshes, showing assigned host ports for any initial services.

## 9. Reclaim disk view

- Lists `orphaned_volumes` (name, human size, last project) from status.
- Per-volume **Delete** (confirm, names it) → `bardolier volumes rm`.
- **Delete all** (confirm, shows total reclaimable) → iterate.
- Nothing automatic: orphans persist until reclaimed, so a detach never loses
  data by surprise, but disk is never hidden.

## 10. Close all & eject

0. If no configured root is a removable volume (`doctor`'s `ssd` finding,
   `roots[].removable` — phase 18), the row reads plain **Close all** and
   calls `bardolier down-all --json` directly rather than `eject`, which would
   only ever answer `EJECT_NOT_APPLICABLE` — and does so before stopping
   anything, so routing through it here would leave every project running
   behind a button that claims to close them.
1. `bardolier eject --json` (which itself runs down-all → holder check → diskutil).
2. On `EJECT_BLOCKED`, render the returned `holders` list ("Xcode, Simulator
   still hold the SSD — quit them") and offer **Retry**. Never force.
2b. On `EJECT_BLOCKED` with `details.reason == "runtime-holds-volume"`, the
   holder is Docker Desktop's own VM: there is nothing to quit and Retry cannot
   clear it. Render it as its own state and offer **Stop Docker & eject**,
   which is `bardolier eject --stop-docker` — the user consenting to the engine
   stopping, not the app deciding to stop it.
2c. On `reason == "runtime-holds-volume-after-stop"` — the same refusal after
   that offer was taken and the CLI waited for the VM to let go — withdraw the
   offer. The engine is already down, so the panel renders the CLI's own
   sentence and leaves **Retry**; a button that repeats what just failed is a
   loop, not a move.
2d. On `EJECT_NOT_APPLICABLE` (`ssd_root` is a plain directory, not a
   removable volume — phase 10), this isn't a failure to show in a banner:
   render it once, then dim the menu row itself with the reason, the same
   treatment a missing archetype Dockerfile gets. There is no Retry — it would
   fail the same way every time.
3. On success, switch the icon to the **ejected** state ("safe to unplug"). If
   the payload says `docker_stopped`, say so: the engine has to be started
   again before the next `up`.

## 11. Icon states

Mounted-idle · activity (operation running) · SSD-absent (dimmed, actions
disabled) · ejected (distinct, safe-to-unplug). Derive purely from the latest
`status`/`doctor`.

## 12. Preferences

- Roots: the configured list, each with a **Forget** button, plus a row to add
  one — a path field, a **Choose…** button opening an `NSOpenPanel` (folders
  only, "New Folder" enabled, since `root add` never creates the directory
  itself), and a name field defaulted from the chosen folder's volume name
  (a courtesy prefill; `root add` validates and can still default from the
  path's basename itself) once a folder is picked.
- Terminal app for shell-open.
- Start-auto-opens-shell toggle (default ON).

Roots are read with `bardolier root list` and written with `bardolier root
add | remove` (`cli-spec.md` §6, §8 — list-valued, so `config set` cannot
touch them); the terminal is read with `bardolier config get` and written with
`bardolier config set`. Only the toggle is the app's own, since the CLI has no
opinion about it. When `$BARDOLIER_ROOT` overrides the roots list, the panel
says so — a preference that appears to save and then does nothing is worse
than one that explains itself.

## 13. Error handling

- Every CLI error code maps to a short, human message; unknown codes fall back to
  the `error.message` string. Never surface a raw stack trace.
- If `bardolier` itself is missing/not on PATH, show a clear first-run message with
  the expected install location.

## 14. What must be true before the app is built

The CLI contract (commands, JSON schemas, error
codes) is implemented and frozen, and the full lifecycle has been driven from the
terminal. The app is written against that frozen contract, not in parallel with
it.

## 15. Implementation map (Swift)

Sources live in `app/Bardolier/Bardolier/Bardolier/` (phase 16). The app reads
the contract; it never re-derives it.

- `BardolierClient` — builds argv, appends `--json` itself (no caller may), and
  turns a non-zero exit into `BardolierFailure.cli` carrying the `cli-spec.md`
  §2 code. It is the only place a `Process` is spawned.
- `BardolierModels.swift` — one struct per object in `cli/schema/*.json`. Closed
  string enums decode as open tokens, so an additive CLI change cannot break an
  older build. `test/app-models.test.ts` holds structs and schemas together as
  text in both directions: a missed field, an invented one, an impossible error
  code, or a `Process` spawned outside the client fails there.
- `BardolierExecutable.swift` — a GUI app inherits no shell `PATH`, so this
  locates `bardolier` and hands the child a `PATH` reaching `node`, `docker`,
  `lsof`, `diskutil`. The only environment knowledge in Swift.
- `BardolierStore` — `activity` names the one operation in flight; while it is
  set, mutating items are disabled, and every mutation is followed by a forced
  `status` refresh rather than a local patch (§4). `ejectPhase` holds
  blocked/working/ejected/failed apart from `lastError`, which the next refresh
  clears — that is what makes a blocked eject (§10) a place to come back to.
  `defaultRootRemovable`/`anyRootRemovable` read `doctor`'s per-root `removable`
  (§5, §10). `bardolierMissing` shows `FirstRunPanel` — listing the paths
  `BardolierExecutable` actually searched — rather than letting each item fail
  its own way (§13).
- `EjectPanel` renders `ejectPhase` and offers **Retry**. Nothing in Swift can
  force an unmount or kill a holder, and `eject` has no `--force`
  (`test/phase7.test.ts`).
- `MenuRow` takes a `disabledReason` and serves it as help; `DisabledNotice`
  says it once per group — a dimmed row and an absent row otherwise look the
  same, and with Docker down every mutating item is disabled for one reason.
- `BardolierTerminal` runs `bardolier shell`'s argv via AppleScript or a
  `.command` file (§7). It launches no process itself.
- Refusals are relayed verbatim: `PROJECT_RUNNING` becomes "Stop the project to
  change its services" (§6), never an unrequested stop-change-start.
  Destructive confirmation happens in the view before the call, because the
  client passes `--force` and the CLI cannot prompt.
- Build settings the human sets in Xcode (`app/README.md`): SwiftUI
  `MenuBarExtra`, `LSUIElement` YES, App Sandbox off for v1,
  `NSAppleEventsUsageDescription` (without it macOS kills the app the first
  time it drives a terminal). The target uses a synchronized folder group, so
  new `.swift` files build without an Add-Files step.
