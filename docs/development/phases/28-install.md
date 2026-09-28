# Phase 28 — `bardolier install`

_Written after the work landed (commit `386f6a1`), reconstructed from the code
and the commit message rather than planned ahead of it — see
`docs/development/phases/README.md`._

**Goal:** A fresh clone works without Xcode or a hand-edited PATH. A GUI app
launched from Finder inherits almost no shell PATH, so `BardolierExecutable`
(Swift) searches a small set of conventional directories instead of a shell's
real one. `bardolier install` is what puts `bardolier`/`bdlr` into one of
them — the same list, in the same order, so the CLI and the app cannot
disagree about where counts as "installed."

**Deliverables:**
- `cli/src/install.ts`: `conventionalBinDirectories()` (must match
  `BardolierExecutable.conventionalDirectories` in Swift), `shimPath()`,
  `chooseBinDir`, `linkOne`, `runInstall` — the search-and-link logic, taking
  an explicit directory rather than going through `Context`, so a test never
  touches the real ones.
- `cli/src/commands/install.ts` + `cli/schema/install.schema.json`:
  `bardolier install [--bin-dir <dir>] [--force]`, `--json` shaped like every
  other command even though the app never calls it — a person or
  `npm run setup`/`setup:app` does, once, before the app exists on the
  machine at all.
- `commands/doctor.ts`'s new `cli` finding: read-only, asks the same question
  `install` answers, as `ctx.cli` on `Context` — catches the state this phase
  exists to fix, a shell that finds `bardolier` (real PATH) while the app
  would not.
- Two new error codes: `INSTALL_NO_WRITABLE_DIR`, `INSTALL_PATH_OCCUPIED`
  (`--force` names the conflicting path).
- `npm run setup` / `npm run setup:app` wired to this.

**Non-goals:** no uninstall command — removing a symlink is `rm`; no PATH
mutation of the user's shell rc files — `install` only ever writes into a
conventional directory already searched.

**Done-check:** `test/install.test.ts` — `chooseBinDir` prefers an existing
conventional directory over creating `~/.local/bin`; `runInstall` is
idempotent (`already_linked`) and replaces only under `--force`
(`INSTALL_PATH_OCCUPIED` otherwise); `resolves` is true only when `bardolier`
would be found under `bin_dir` plus the system directories alone, no
inherited PATH. `test/status.test.ts`'s `cli` finding case scripts both
answers through `Context` rather than the real machine.
