# Phase 30 — `bardolier adopt`

_Written after the work landed (commit `386f6a1`), reconstructed from the
code and the commit message rather than planned ahead of it — see
`docs/development/phases/README.md`._

**Goal:** The mechanical half of bringing an existing, non-bardolier project
onto bardolier (`docs/migration-guide.md` steps 3-4) as one atomic step:
create the project and get the repository into `work/<repo>/`. Judgement —
which archetype, which services, when to `git clone` the source's origin
instead of moving its working tree — stays with whoever runs the migration;
this command does not guess at any of it, the same way `new` does not guess a
service list.

**Deliverables:**
- `cli/src/commands/adopt.ts`:
  `bardolier adopt <source-path> <name> --archetype <a> [--services a,b]
  [--root <name>] [--move] [--dry-run]`. Structured like `new`/`clone`:
  everything that can fail (name free, root readable, archetype known,
  services resolvable, source readable, enough space) is checked before
  anything is written; staged off to one side and swapped in only once
  complete (`transfer.ts`), so an interrupted adopt leaves the target root
  exactly as it found it.
- Unlike `move` (phase 21), the source is always copied into the staged
  project rather than renamed in place — it lands one level down, inside a
  project this call is also creating. `--move` only removes the source
  afterwards, once the copy is confirmed landed.
- `cli/src/model/adopt.ts` + `cli/schema/adopt.schema.json`: `AdoptOutput`,
  shaped like `NewOutput`/`CloneOutput` plus where the content came from.
  `--dry-run` reports the same plan with nothing written, **except a host
  port** — a port is chosen at write time from whatever is free right then
  and can differ between the dry run and the real one, so `services` is
  always empty and `manifest_path`/`compose_path`/`seeded` are absent under
  `--dry-run`. `bytes` is still real: sizing the source is a read-only stat
  walk with nothing to go stale.

**Non-goals:** no interactive prompting inside the command itself — that
judgement layer is the migrate-project skill (phase 29); no support for a
source that is itself already a bardolier project (that is `clone`, phase 20).

**Done-check:** `test/adopt.test.ts` — a dry run reports no port and writes
nothing; a real run's `--dry-run` immediately before it can report a
different port than the one actually allocated; `--move` only removes the
source after the staged copy lands, never before; an interrupted stage (mid
`copyInto`) leaves the target root exactly as `requireFreeName` found it.
