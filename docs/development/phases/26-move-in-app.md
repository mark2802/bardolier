# Phase 26 — move from the menu bar

**Goal:** the per-project submenu grows `Move to…`, so the command phase 21
built is reachable without a terminal.

**Grounding.** Phase 21 deliberately shipped `move` CLI-only — the contract is
driven from the terminal with `--json` first, and this is the app phase that
follows, same as phase 25 was to phase 20. Nothing about the CLI changes:
`move.schema.json` is already frozen, and the app decodes it the way it decodes
`clone`.

`move` takes no name and no content choice — the only thing to pick is a
destination root, so this is not a `NewProjectPanel`-shaped form. It is small: a
root picker and a `Move` button. And unlike `clone`'s `--with-content`, a
running project cannot be moved AT ALL (`PROJECT_RUNNING` is a whole-command
refusal, not a per-field one) — so the disabled-with-a-reason treatment (§11)
lands on the panel's one action, not on a checkbox inside it.

Naming the root a project already occupies is a valid, idempotent CLI call
(`moved: false`), but it is not a choice the UI needs to offer: the panel's
picker lists every OTHER configured root, the same way `ClonePanel`'s own root
picker is absent rather than disabled when there is only one root to offer
(app-spec.md §8.1). By the same reasoning, the `Move to…` row itself only
appears with more than one configured root — with one, there is nowhere to
move a project, and a row that always leads nowhere is worse than no row.

**Deliverables:**
- `MoveOutput` and `MoveLocation` in `BardolierModels.swift` — `project`,
  `moved`, `from`/`to` (each a `MoveLocation { root, dir }`), `bytes`, and
  `mode` as a `MoveMode` token (`BardolierToken`, `.rename` / `.copy`) per the
  file's own rule that a closed schema enum decodes openly so an additive CLI
  change cannot break an older build.
- `BardolierClient.move(project:root:)` — argv only, `--json` appended by `run`
  as always.
- `BardolierStore.move(project:root:)` returning the payload so the panel
  closes only on success, like `clone`. Its notice names the destination root
  and, when `mode == .copy`, the bytes moved (mirroring `clone`'s
  `bytesCopied` notice) — an instant rename does not need the byte count
  advertised. A no-op (`moved == false`) gets its own notice ("Already on
  `<root>`.") rather than a `Moved…` line that implies something happened.
- `Views/MovePanel.swift` (**MANUAL: new Swift file**) — `PanelHeader`, a root
  picker over every configured root EXCEPT the project's own, disabled with a
  reason while the project is running, and a `Move` button, plus the standard
  error banner. No name field, no checkbox: there is nothing else to decide.
- `MenuPanel.move(project:)` in `MenuBarRootView.swift`, and a `Move to…` row
  in `ProjectRow` between `Clone…` and `Open folder in Finder` — present only
  when `store.roots.count > 1`, and disabled by `canMutate` plus the project's
  own running state (mirroring `Delete…`'s use of `disabledReason`, with its
  own reason — "Stop `<name>` to move it." — when the block is the running
  state rather than a busy/degraded store).
- `app-spec.md` §5 (the submenu), a new §8.2 for the panel (after §8.1 Clone),
  and §15's map.

**Non-goals:** no offering the project's own root as a destination — the CLI's
idempotent no-op stays a scripting affordance, not a UI choice. No progress
bar: the activity label is what says a copy is working, same as `clone`. No
confirmation sheet — `move` relocates a project, it never destroys one, so the
button is its own confirmation (the same reasoning as `clone`'s non-goal). No
attempt to repair anything under `work/` or `local/` that baked in a host path;
that is the CLI's own non-goal (phase 21) and the app does not pretend
otherwise.

**Done-check** — folded into `test/app-done-check.sh` and
`test/app-models.test.ts`, where the app's surfaces already live:

- `MoveOutput` and `MoveLocation` satisfy `move.schema.json` in both directions
  (the `MIRRORS` table);
- `MovePanel.swift` exists and spawns no `Process` of its own;
- the panel's root picker excludes the project's own root;
- `MenuPanel` carries a `.move(project:)` case, and `ProjectRow` offers
  `Move to…`;
- the panel's action carries a disabled reason while the source project is
  running, so a blocked move explains itself rather than looking broken;
- `MovePanel` routes its call through `store.move(...)` and `client.move(...)`
  — nothing spawns a `Process` outside the client;
- `bardolier move --json` still validates against its schema from the app's
  own sandbox — the app is a client of a contract that has not moved.
