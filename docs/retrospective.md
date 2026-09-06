# Retrospective — phases 0-19

Written 2026-09-06, at the point where the product is close to its intent and
the cost of getting there is worth accounting for. Not a spec. Nothing here
changes behaviour; it exists so the next project starts differently.

## The number

Phases 0-8 — the entire CLI and the app — landed in 5½ days (Aug 20-25),
~20,000 insertions. Phases 9-19, which are largely corrections to that
foundation, took 12 days (Aug 26 - Sep 6). **Two thirds of the elapsed time
went to fixing decisions made in the first third.** Phase 1 (2,179 insertions)
was committed 27 minutes after Phase 0 (2,669 insertions); Phase 6 is a single
3,451-line commit. None of that was reviewed, and none of it could have been.

## The common cause

Irreversible decisions were made *inside* work items instead of before them.
Every finding below is a variant of that.

## Findings

**1. The toolchain was chosen by the implementer, in passing.** The archived
plan's Phase 0 bullet reads: *"Choose the CLI language/runtime (recommend:
TypeScript on Node…)"*. It correctly identified a decision and resolved it in
the same sentence. That shape gets rubber-stamped. TypeScript/Node is not a
problem in itself — the owner knows other languages better and would have
chosen differently, and never got a moment where the choice was open.

**2. The storage intent was never written as an invariant, so it was never
checkable.** §1 of the spec says projects live "on the external SSD" — a
location for a folder, not a rule about where bytes live. So each phase
re-decided it ad hoc, in both directions: `b8d9dde` moved the Gradle cache
*off* the SSD (Aug 25); phases 17 and 19 moved service data *off* the internal
disk (Sep 5-6). One question, three phases, three answers. The rule that was
missing is roughly: *the only bardolier bytes on the internal disk are shared,
re-downloadable images and caches; everything project-specific lives under the
root.* Stated that way it is a `du` assertion, and it fails at Phase 2.

**3. Done-checks were written by the agent that wrote the code.** They test
internal self-consistency, not intent. At least one acceptance criterion per
phase should be written by the owner, before the work starts, phrased as
something observable from outside the code.

**4. The contract was frozen before anything real ran against it.** Phase 4 is
titled "contract freeze" — before the app existed, before one real project had
been migrated. It bought stability for a model that had not met reality, and
made every later model change cost four places (TS definition, JSON schema,
Swift mirror, contract tests both ways). Phases 17-19 changed the model anyway,
at 25/78/64 files. The envelope (error codes, the single-JSON-value rule) was
genuinely stable and worth freezing early; payload shapes were not.

**5. The highest-yield review happened at phase 11 instead of phase 2.**
Writing the migration guide — putting a real existing project through the tool
— immediately produced the gaps that became Phase 12 (extra ports), Phase 13
(extra packages) and the still-open provisioning gap. Spec reading found none
of them. Dogfooding is the only review that does not compete with the owner's
attention budget.

**6. Output volume exceeded review capacity by about an order of magnitude.**
A "phase" was sized to what an agent produces in one go, not to what a human
reads in one sitting. The consequence is exactly the reported experience:
learning what had been built by using it, weeks later.

**7. The authoritative document is written and rewritten by the implementer.**
`cli-spec.md` is 645 lines and is edited in nearly every phase commit. There is
no artefact of the owner's intent that the agent cannot rewrite, so when intent
and implementation diverge the spec silently follows the implementation and the
divergence becomes unobservable.

**8. The name was decided last and was wrong twice.** `cproj`/`claude-yard` →
`bandolier` → `bardolier`, plus Xcode targets and env-var prefixes: ~3,500
lines across five commits and parts of four days. The CLI and the app should
have shared one name from the first identifier typed, and the trademark problem
— a product named after another company's product — surfaced late enough that
Phase 20 must now ship a NOTICE disclaiming affiliation.

**9. "Phase 8 — the last planned phase," and there were eleven more.** The
upfront 0-9 ladder implied a finished product and got the product's shape
wrong. Switching at phase 10 to one small scoped spec per unit of work is the
best process change in the project.

**10. The app is structurally unreviewed.** 5,004 lines of Swift, verified only
by text comparison against the JSON schemas, because the agent cannot build or
run it and the owner was not reviewing. The environment boundary is right; the
absent verification loop is the gap.

**11. Prose length looked like rigour and partly substituted for it.** The
specs, CLAUDE.md and the commit messages are essay-length; the token-discipline
section exists because the cost eventually became painful. A well-argued
paragraph about `isActionableHolder` is not evidence that the storage layout is
right, but it reads like diligence.

## The agent's share

The toolchain was recommended inside a work item rather than surfaced as a
choice. The contract freeze was proposed before there was a user. Phases were
sized to output rate rather than reading rate. The essays were written.

## What to do differently

- **A decisions register, answered before the phase that depends on it.**
  Language, name, licence, storage layout, data formats. Rule of thumb: if
  reversing it later would touch more than ~20 files, it never appears as a
  bullet inside a plan.
- **Intent as testable invariants, owned by the human.** A short `INTENT.md`
  (15-30 lines: purpose, invariants, non-goals, decisions taken) that the agent
  may quote and never edit, separate from the spec it maintains. Conflicts get
  raised, not reconciled.
- **A real project running on it by day two**, and again every few phases.
- **Size units by review capacity** — one command or one seam per commit, ~400
  lines of new logic. If it cannot be reviewed today, it is not started today.
  This costs throughput deliberately.
- **Plan only to the smallest slice a real project can run on**, then let use
  drive the phases, as phases 10+ did.
- **Budget prose from the start** (CLAUDE.md ≤ 100 lines, a phase spec ≤ 1
  page) and spend the difference on checks.
- **Decide whether the app gets a verification loop** — human walk-through as
  part of an app phase's done-check — or is knowingly accepted as unverified
  and kept small.
