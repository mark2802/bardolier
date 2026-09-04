# Phase 20 — the publishing set

**Goal:** Everything a stranger needs and nothing this developer's machine
left behind. The repo currently has no LICENSE, no README, docs written for
one contributor, and three files carrying personal paths.

**Deliverables:**
- `LICENSE` — Apache 2.0, verbatim. Chosen over MIT for the explicit patent
  grant and, more to the point here, §6: it disclaims any licence to the
  licensor's trademarks, which is the right posture for a project that names
  another company's product on every page.
- `NOTICE` — copyright line, and a plain statement that the project is not
  affiliated with, endorsed by, or sponsored by Anthropic. The README names
  Claude Code throughout; that is nominative use and is fine, but saying so
  costs one line. **No per-file licence headers** — Apache recommends them and
  does not require them, and this repo's file headers are already carrying
  design reasoning that a boilerplate block would bury.
- `README.md`: what the tool is (one paragraph, including that it is a macOS
  host driving Linux dev containers); prerequisites (Docker Desktop, Node
  ≥ 22.18, Xcode for the menu-bar app); install and quickstart to a running
  project; that an external disk is optional and a root can be any directory;
  the menu-bar app as a thin client; the security section below; links to
  `docs/`; licence and the trademark line.
- **Security posture, in the README, stated plainly.** This is the substantive
  version of "remove any mention of `--dangerously-skip-permissions`": that
  flag appears nowhere in the tree and there is nothing to delete, so the
  deliverable is an assertion in the done-check plus an honest description of
  what the containers actually are. Namely: the dev container runs as the host
  uid/gid and bind-mounts real project files at `/work`, so it is an
  environment boundary, not a sandbox for the code inside it; `PASSTHROUGH_ENV`
  lends real host credentials into the container when they are set on the Mac
  (list them, and note the list form means unset stays unset — never an empty
  credential); the agent is installed in the base image and keeps its own
  permission prompts; `shell --root` (phase 14, if landed) is root inside one
  container and nothing more.
- Docs triage. `cli-spec.md`, `app-spec.md` and `migration-guide.md` are for
  users and stay at `docs/`. `docs/phases/`, `docs/archive/` and
  `migration-guide-gaps.md` are development scaffolding and move to
  `docs/development/` — kept, because the reasoning in them is most of what
  makes the repo worth reading, but not presented as user documentation.
- `CLAUDE.md` rewrite. Its design-reasoning sections are the best documentation
  in the repo and stay. Its "Claude runs in a Linux dev container, the human
  works on macOS host-side" environment boundary is *this* developer's setup,
  not a contributor's: that moves to `CONTRIBUTING.md` alongside the toolchain
  and test-ladder instructions, phrased as how to work on the project rather
  than as instructions to one agent.
- Personal scrub: the hard-coded path in the Xcode scheme (already handled in
  phase 16), `/Users/mark/projects` in `test/phase10.test.ts`, and
  `.claude/settings.local.json` — which should be `.gitignore`d rather than
  edited.

**Non-goals:** no CI configuration, no release automation, no Homebrew formula,
no code of conduct or issue templates — none of them is needed to publish, and
each is a commitment to maintain something. No screenshots of the app until
someone asks for them.

**Done-check:** `test/phase20-done-check.sh` asserts `LICENSE` exists and is
Apache 2.0; `NOTICE` and `README.md` exist and the README has the required
sections including Security; `grep -ri "dangerously-skip-permissions"` over the
tree returns nothing; no personal path or email appears in any tracked file;
and — folding in phases 15 and 16 — no occurrence of the old names remains.
Land as a section in `test/regression.sh` (`LAST=20`).
