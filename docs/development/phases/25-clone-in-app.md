# Phase 25 — clone from the menu bar

**Goal:** the per-project submenu grows `Clone…`, so the command phase 20 built
is reachable without a terminal.

**Grounding.** Phase 20 deliberately shipped `clone` CLI-only — the contract is
driven from the terminal with `--json` first, and this is the app phase that
follows. Nothing about the CLI changes: `clone.schema.json` is already frozen,
and the app decodes it the way it decodes `new`.

The panel is `NewProjectPanel` with one field fewer and one checkbox more. Name,
optional root, and `--with-content`; no archetype and no service list, because a
clone takes both from its source (§4.2). It opens from a project row, so the
source is always a named project rather than "the selected one".

The one state-dependent control is `--with-content`. The CLI refuses it on a
running project (`PROJECT_RUNNING`), and a shape clone of that same project
succeeds — so the checkbox is **disabled with a reason** while the source is up,
and the panel still clones. That is §11's rule, not a new one: a dimmed control
and an absent one otherwise look the same. The app does not stop the project to
make the checkbox available, exactly as it does not stop one to change its
services (§6).

**Deliverables:**
- `CloneOutput` in `BardolierModels.swift` — `NewOutput`'s fields plus `source`,
  `withContent`, `bytesCopied`; `project` decodes as the existing
  `CreatedProject`, and `services` as `AttachedService`, since `clone`'s schema
  carries both blocks verbatim.
- `BardolierClient.clone(source:name:root:withContent:)` — argv only, `--json`
  appended by `run` as always.
- `BardolierStore.clone(...)` returning the payload so the panel closes only on
  success, like `create`. Its notice names the fresh ports and, under
  `--with-content`, the bytes copied — the two things the user cannot predict.
- `Views/ClonePanel.swift` (**MANUAL: new Swift file**) — name field with the
  same courtesy validation `NewProjectPanel` does (the CLI still decides), root
  picker only with more than one configured root, the `--with-content` checkbox
  with its disabled reason, and the standard error banner.
- `MenuPanel.clone(project:)` in `MenuBarRootView.swift`, and a `Clone…` row in
  `ProjectRow` between `Services…` and `Open folder in Finder`. Disabled by
  `canMutate` like the other mutating rows.
- `app-spec.md` §5 (the submenu), a new §8.1 for the panel, and §15's map.

**Non-goals:** no cloning across Macs, no progress bar — `cpSync` is synchronous
inside one CLI call and the activity label is what says it is working. No
"clone and start": the notice already says what the ports are, and `up` is one
row away. No confirmation sheet — clone creates, it never destroys, so the
button is its own confirmation.

**Done-check** — folded into `test/app-done-check.sh` and
`test/app-models.test.ts`, where the app's surfaces already live:

- `CloneOutput`, `CreatedProject` and `AttachedService` satisfy
  `clone.schema.json` in both directions (the `MIRRORS` table);
- `ClonePanel.swift` exists and spawns no `Process` of its own;
- the panel's `--with-content` control carries a `disabledReason`, so a running
  source explains itself rather than looking broken;
- `ProjectRow` offers `Clone…`, and `MenuPanel` can carry the project it is for;
- `bardolier clone --json` still validates against its schema from the app's
  own sandbox — the app is a client of a contract that has not moved.
