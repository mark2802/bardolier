# Phase 29 — the migrate-project skill

_Written after the work landed (commit `386f6a1`), reconstructed from the
skill file and the commit message rather than planned ahead of it — see
`docs/development/phases/README.md`._

**Goal:** `docs/migration-guide.md` is a document a human or an agent follows
by hand. This phase adds `.claude/skills/migrate-project/SKILL.md`, a driver
that runs the guide rather than restating it — the guide and
`docs/development/migration-guide-gaps.md` stay the single source of truth
for what to do and why.

**Deliverables:**
- `.claude/skills/migrate-project/SKILL.md`: takes the source project's path
  as its argument; reads the guide and the gaps file in full before doing
  anything; turns every guide STOP (archetype choice, service mapping, the
  Part 2 port-policy decision) into an actual question to the owner instead
  of a guess.
- Runs the guide's mechanical steps (Part 1 steps 3-4) as one
  `bardolier adopt <source> <name> --archetype <a> [--services a,b]
  [--root <name>] [--move]` call — `--dry-run` first, plan shown, then for
  real — never a hand-composed `new` + `mv`/`git clone`.
- Never hand-composes a port: reads `bardolier status <name> --json` for the
  real numbers after `adopt` (or a later `service add`/`port add`) instead of
  writing down what `--dry-run` reported.
- Files a new `docs/development/migration-guide-gaps.md` entry — generically
  phrased, naming no project — when something the guide doesn't cover looks
  likely to recur; routes around a one-off directly instead.

**Non-goals:** does not decide unsupervised — every guide STOP stays a STOP;
does not invent workarounds for missing capabilities beyond filing them; does
not edit `docs/migration-guide.md` itself.

**Done-check:** manual — run the skill against a real non-bardolier project
and confirm it stops at each STOP, calls `adopt --dry-run` before the real
run, and never writes a port number it did not just read back from
`status --json`.
