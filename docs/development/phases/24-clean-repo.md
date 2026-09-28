# Phase 24 — the repo move

_Rewritten after the decision below; the original spec called for squashing
to one commit. See `docs/development/phases/README.md` for how this project
handles a spec that a later decision superseded — the record stays, this file
just states the current plan._

**Goal:** Publish under the new name, at a new remote, with the development
history intact rather than squashed.

**The reversal, stated once.** The original plan here was to discard history
on the ground that it recorded rework the owner didn't want visible. On
review that record — `docs/development/retrospective.md`, the phase specs, the
comments — argues the opposite: it shows a real feedback loop (a documented
retrospective that changed how later phases were planned) rather than an
absence of rigour, and it is most of what makes the repo worth reading
(`README.md`). What genuinely needed fixing was narrower — stale
cross-references and internal phase numbers leaking into user-facing surfaces
— and that cleanup is done as its own pass, not by discarding the history.

**What still needs doing before this is public**, independent of the history
decision:
- The 39 commits (of 52) carrying a `Claude-Session:` trailer with a live
  `claude.ai/code/session_…` URL — private links that don't belong in a public
  history.
- All 52 commits have an empty author email (`Mark <>`).
- Whether `Co-Authored-By: Claude …` trailers (46 of 52 commits) stay, are
  reworded, or are dropped — the owner's call, not a default.
- The remote is still the pre-rename repo (see phases 15-16 for that
  rename's history); the correctly-named `mark2802/bardolier` repo does not
  exist yet.

**Steps:**
- Decide the three trailer/email questions above.
- Create the new, empty `mark2802/bardolier` repository.
- Rewrite the trailers and author email across the existing history (a
  filter over every commit, not a squash), then push the rewritten history
  into the new, empty repo — pushing into an empty repo avoids force-pushing
  over anything already published.
- Verify `.gitignore` covers `node_modules/`, `.DS_Store`, the Xcode artefacts
  already listed, and `.claude/settings.local.json`; confirm `git status` is
  clean and `git ls-files` contains nothing generated, nothing personal, and no
  `docker-compose.yml` or `project.yml` from a real project.
- Fresh-clone verification, on a machine (or a container) that has never run
  the tool: `npm install`; `npm run typecheck`; `npm run test:quiet`;
  `BARDOLIER_SKIP_DOCKER=1 bash test/regression.sh`. Then follow the README's
  quickstart literally, from the top, changing nothing — every step that needs
  a fact the README does not state is a README bug, and this is the pass that
  finds them.
- The human opens the renamed Xcode project on the host, builds, runs, and
  confirms the menu bar app finds the CLI and lists projects.
- Decide what happens to the old, pre-rename remote (archived or deleted)
  once the new one is verified.

**Done-check:** the fresh clone above, green, the README quickstart completed
without consulting any other file, and `git log` on the new remote showing no
session URL and no empty author email on any commit.
