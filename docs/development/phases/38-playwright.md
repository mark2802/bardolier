# Phase 38 — Playwright in `bardolier-web`

**Goal:** web and library projects can run browser tests with no setup.

**Deliverables:**
- `cli/images/bardolier-web/Dockerfile`: pinned `PLAYWRIGHT_VERSION`, global install,
  `playwright install --with-deps chromium` into `/opt/ms-playwright` (in the image, as the
  libraries need root).
- `cli/src/scaffold.ts`: `PLAYWRIGHT_VERSION` label (env.md lists it via `imageToolchain`);
  web/library boundary text says to match the version.
- `cli-spec.md` §4.3.

**Non-goals:** no firefox/webkit; no headed browsers.

**Done-check:** `test/images.test.ts`, `test/lifecycle.test.ts` env.md checks; building the
image and a headless `chromium.launch()` is unrun (needs Docker).
