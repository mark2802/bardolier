# Phase 32 — Project seeds under `work/<name>/`

**Goal:** `new` seeds a minimal `CLAUDE.md` plus `docs/{env,product,dev-principles}.md`
in `work/<name>/`, so other repos can be cloned into `work/` beside the project and the
environment is described without depending on bardolier.

**Decision:** the folder is recorded as `work_folder` in `project.yml` (INTENT.md,
2026-10-11), not inferred from `CLAUDE.md`/`env.md` — six review passes patched that guess.

**Deliverables:**
- `cli/src/scaffold.ts`: `claudeMd`, `envMd(manifest, services)`, `productMd`,
  `devPrinciplesMd`; `seededFiles(manifest, services)` returns the four paths.
- `cli/src/images.ts`: `imageToolchain` reads pinned versions from the bundled
  Dockerfile's `ARG` lines.
- `project.yml` gains optional `work_folder` (schema, model, `orderManifest`); `new`,
  `adopt` and a shape `clone` set it to the project name, `clone --with-content` copies
  it and re-renders only a bardolier-rendered `env.md`.
- `Docker.exec` gains `workdir`; `agentWorkdir` (`layout.ts`) gives `/work/<work_folder>`
  when recorded and present, else `/work`, for `shell` and the handoff (§10, §12).
- `env --write` refuses a project with no `work_folder`.
- `cli-spec.md` §3, §4.2, §6, §10, §12.

**Non-goals:** no change to compose; no migration of old projects (no `work_folder`
means `/work`; add the field by hand); no `git init`.

**Done-check:** `test/lifecycle.test.ts` (seed set, `env.md` has services and no host
port or bardolier commands, one footer line, clone), `test/layout.test.ts`,
`test/env.test.ts`, `test/shell.test.ts`, `test/handoff.test.ts` (workdir),
`test/contracts.test.ts` (`work_folder` pattern), and the layout/lifecycle/images shell checks.
