# Phase 33 — `adopt` into `work/<name>/`

**Goal:** the adopted repo becomes the project in development, at `work/<name>/`,
and seeds fill gaps without overwriting the repo's own `CLAUDE.md` or `docs/`.

**Deliverables:** `adopt.ts` copies to `work/<name>/` and writes a seed only if absent;
`seeds_skipped` in the output and `adopt.schema.json`; `migration-guide.md` and the
`migrate-project` skill updated.

**Non-goals:** no merging of an existing `CLAUDE.md`; the guide tells the owner to add
the pointers by hand.

**Done-check:** `test/adopt.test.ts` (gap-fill keeps the repo's files and lists them in
`seeds_skipped`); `lifecycle-done-check.sh` §9.
