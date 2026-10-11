# Phase 32 — Project seeds under `work/<name>/`

**Goal:** `new` seeds a minimal `CLAUDE.md` plus `docs/{env,product,dev-principles}.md`
in `work/<name>/`, so other repos can be cloned into `work/` beside the project and the
environment is described without depending on bardolier.

**Deliverables:**
- `cli/src/scaffold.ts`: `claudeMd`, `envMd(manifest, services)`, `productMd`,
  `devPrinciplesMd`; `seededFiles(manifest, services)` returns the four paths.
- `cli/src/images.ts`: `imageToolchain` reads pinned versions from the bundled
  Dockerfile's `ARG` lines.
- `new`/`clone` use the new seed set (`clone` writes a seed only where the copy
  brought none).
- `Docker.exec` gains `workdir`; the handoff runs `claude --continue` in
  `/work/<name>` when its `CLAUDE.md` exists and no flat `work/CLAUDE.md` does (§10, §12); `shell` opens there too.
- `cli-spec.md` §3, §6, §10, §12.

**Non-goals:** no change to compose or the manifest ; old
projects' `work/CLAUDE.md` is left alone; no `git init`.

**Done-check:** `test/lifecycle.test.ts` (seed set, `env.md` has services and no host
port or bardolier commands, one footer line), `test/layout.test.ts`,
`test/handoff.test.ts` (workdir), and the layout/lifecycle/images shell checks.
