# Phase 36 — `spec.md` seed

**Goal:** `new` also seeds `docs/spec.md` — what the system does, in detail (features, rules,
edge cases, acceptance criteria) — so a requirements document has a home that is not
`product.md` (why, for whom). The agent keeps it current, like `architecture.md`.

**Deliverables:**
- `cli/src/scaffold.ts`: `specMd`; `seededFiles` returns seven paths; `claudeMd` names six docs.
- `cli-spec.md` §3, §6 (`new`), §10; `migration-guide.md` seed mentions.

**Non-goals:** no migration of existing projects (`adopt` fills seed gaps).

**Done-check:** `test/{layout,lifecycle,adopt}.test.ts` and `test/layout-done-check.sh`.
