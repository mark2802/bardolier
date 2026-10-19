# Phase 35 — `architecture.md` and `design.md` seeds

**Goal:** `new` also seeds `docs/architecture.md` (stack, structure, interfaces, decisions
table) and `docs/design.md` (visual, interaction, voice and copy), so project-specific
technical and UI knowledge has a home beside `product.md`.

**Deliverables:**
- `cli/src/scaffold.ts`: `architectureMd`, `designMd`; `seededFiles` returns six paths;
  `claudeMd` names five docs and who owns each (product, dev-principles: owner's; architecture, design: agent keeps
  current; env: generated, no tool named).
  `devPrinciplesMd`'s `## Design` becomes `## Code structure`.
- `cli-spec.md` §3, §10; `migration-guide.md` seed mentions.

**Non-goals:** no migration of existing projects (`adopt` fills seed gaps); no conditional seeding.

**Done-check:** `test/{layout,lifecycle,adopt}.test.ts` and `test/layout-done-check.sh`.
