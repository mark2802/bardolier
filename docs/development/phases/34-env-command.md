# Phase 34 — `bardolier env`

**Goal:** `docs/env.md` is seeded once and drifts as services and ports change; give
the owner a way to refresh it that never writes into a repo uninvited.

**Deliverables:** `bardolier env <name> [--write]` (`commands/env.ts`,
`model/env.ts`, `schema/env.schema.json`, registry entry, `cli-spec.md` §6). Prints by
default; `--write` overwrites and reports `changed`, skipping identical bytes.

**Non-goals:** no app UI for it; no automatic regeneration on `service add`.

**Done-check:** `test/env.test.ts`; `test/contracts.test.ts` command list.
