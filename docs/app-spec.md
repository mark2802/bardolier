# App Spec — Menu-Bar Container Project Manager

Status: draft for implementation. macOS status-bar app; a **thin client** over
the `cproj` CLI. Companion docs: `cli-spec.md` (the engine — authoritative for
all behaviour), `implementation-plan.md`, `CLAUDE.md`.

**The CLI is the API; the app is a thin client.** The app shells out to `cproj`,
parses `--json`, and renders. It contains no Docker/orchestration logic and holds
no persistent state beyond UI preferences.

---

## 1. Platform

- SwiftUI `MenuBarExtra`, macOS. Built as its own Xcode project (see
  `implementation-plan.md` for when the human creates it and how Claude-generated
  Swift files are added to the target).
- No sandbox entitlement that would block shelling out to `docker`/`cproj`
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

- A single `CprojClient` type wraps process execution: builds argv, always passes
  `--json`, decodes into `Codable` models mirroring the CLI schemas, maps the
  `error.code` strings to a Swift error enum.
- On every menu open and after every mutating action, call `cproj status --json`
  and re-render. Debounce so rapid reopens don't stack calls.
- Long operations (`up`, `down`, `eject`, `build`) run off the main thread with a
  progress indicator; conflicting actions disabled until completion.
- `cproj doctor --json` on launch; if Docker down or SSD absent, reflect in the
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

- Running project shows **Stop** + **Open shell**; stopped shows **Start**.
- **Start** brings the project up and, per preference (default ON), opens a shell
  (see §7). **Open shell** is always available for a running project.
- Each project item shows attached services with host ports in its submenu
  (click-to-copy connection string — the debugging payoff).

## 6. Services submenu (per project)

Lists every catalogue service with a checkmark if attached; each attached row
shows its host port and a copy-connection action.

- **Attach**: calls `cproj service add`. If the project is running, the CLI
  returns `PROJECT_RUNNING`; the app shows "Stop the project to change services"
  rather than attempting it. (Both add and remove require stop/start.)
- **Detach**: calls `cproj service remove`; the volume is kept and later appears
  in Reclaim disk. Confirm, naming the service.
- After any change, show the newly assigned host port.

## 7. Shell opening

- The CLI (`cproj shell <name> --json`) returns the container name and the exec
  argv. The **app** launches the user's terminal running that command.
- Terminal choice is a **Preference** (Terminal.app default; iTerm, Ghostty,
  etc. optional). The app uses the configured terminal to run the exec command.
- **Start auto-opens a shell by default** (preference-controlled) so single-project
  starts drop you straight in. When batch-starting (Close-all's inverse isn't a
  thing, but multi-start via repeated clicks), the preference lets the user avoid
  a stack of windows.

## 8. New project window

Small modal:
- **Name** — validated (no spaces; no collision; the app calls `list` to check).
- **Archetype** — web / iOS / Android / library.
- **Services** — checkbox list from the catalogue (from `cproj status`/catalogue).
- **Create** → `cproj new … --json`; on success the window closes and the menu
  refreshes, showing assigned host ports for any initial services.

## 9. Reclaim disk view

- Lists `orphaned_volumes` (name, human size, last project) from status.
- Per-volume **Delete** (confirm, names it) → `cproj volumes rm`.
- **Delete all** (confirm, shows total reclaimable) → iterate.
- Nothing automatic: orphans persist until reclaimed, so a detach never loses
  data by surprise, but disk is never hidden.

## 10. Close all & eject

1. `cproj eject --json` (which itself runs down-all → holder check → diskutil).
2. On `EJECT_BLOCKED`, render the returned `holders` list ("Xcode, Simulator
   still hold the SSD — quit them") and offer **Retry**. Never force.
3. On success, switch the icon to the **ejected** state ("safe to unplug").

## 11. Icon states

Mounted-idle · activity (operation running) · SSD-absent (dimmed, actions
disabled) · ejected (distinct, safe-to-unplug). Derive purely from the latest
`status`/`doctor`.

## 12. Preferences

- SSD volume path / root (written to the CLI config so there is one source).
- Terminal app for shell-open.
- Start-auto-opens-shell toggle (default ON).

The first two are read with `cproj config get` and written with
`cproj config set` (`cli-spec.md` §8); only the toggle is the app's own, since
the CLI has no opinion about it. When an environment variable overrides a key,
the write still happens and the panel says the environment wins — a preference
that appears to save and then does nothing is worse than one that explains
itself.

## 13. Error handling

- Every CLI error code maps to a short, human message; unknown codes fall back to
  the `error.message` string. Never surface a raw stack trace.
- If `cproj` itself is missing/not on PATH, show a clear first-run message with
  the expected install location.

## 14. What must be true before the app is built

Per `implementation-plan.md`: the CLI contract (commands, JSON schemas, error
codes) is implemented and frozen, and the full lifecycle has been driven from the
terminal. The app is written against that frozen contract, not in parallel with
it.
