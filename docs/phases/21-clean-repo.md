# Phase 21 — the clean repo

**Goal:** Publish as a first commit, under the new name, with no history.

Not a code phase — a checklist, and the point at which phase 20's work is
actually tested, because the only honest test of a README is a machine that has
never run the tool.

**The trade, stated once.** Squashing discards the phase-by-phase development
record. That record is largely duplicated by `docs/development/`, which is why
this is acceptable; what it is *not* is recoverable, so the old repository is
archived locally and not deleted.

**Steps:**
- Archive the existing repository (it is the only copy of the history) and
  confirm the archive is readable before anything else happens.
- New repository under the new name. `git init`, one commit, one branch.
- Verify `.gitignore` covers `node_modules/`, `.DS_Store`, the Xcode artefacts
  already listed, and `.claude/settings.local.json`; confirm `git status` is
  clean and `git ls-files` contains nothing generated, nothing personal, and no
  `docker-compose.yml` or `project.yml` from a real project.
- Fresh-clone verification, on a machine (or a container) that has never run
  the tool: `npm install`; `npm run typecheck`; `npm run test:quiet`;
  `bash test/regression.sh --through 7`. Then follow the README's quickstart
  literally, from the top, changing nothing — every step that needs a fact the
  README does not state is a README bug, and this is the pass that finds them.
- The human opens the renamed Xcode project on the host, builds, runs, and
  confirms the menu bar app finds the CLI and lists projects.
- Push.

**Done-check:** the fresh clone above, green, plus the README quickstart
completed without consulting any other file.
