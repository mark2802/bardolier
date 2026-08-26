# Phase 11 — Python in the web image

**Goal:** Existing projects being migrated onto cproj typically pair a Python
API with a React frontend. The `web`/`library` archetype's dev container is
already a general-purpose devbox (bind-mounted `/work`, `sleep infinity`, exec
in and run whatever) — it just has no Python. Add one, with a shared package
cache, so both halves of such a project run in the single dev container this
tool already gives it. No compose-model change: the frontend dev server (on
the one published `app_port`) proxies API calls to the backend, which runs on
an internal-only port inside the same container — the existing "one thing
published" rule (§9) is unaffected.

**Deliverables:**
- `cli/images/claude-web/Dockerfile` gains `uv` (astral-sh/uv), pinned and
  checksum-verified from the release's `.sha256` sidecar — same posture as the
  Claude Code binary already in this image. `uv` manages Python installs
  itself; no separate `apt-get install python3`.
- `UV_CACHE_DIR=/cache/uv`, a shared named volume, for the same reason
  `GRADLE_USER_HOME` is one (§4.3): downloaded wheels are rebuildable and
  identical across projects, and belong on the internal disk once, not
  per-project on the SSD. `UV_PYTHON_INSTALL_DIR=/cache/uv/python` shares the
  same volume (`IMAGE_CACHE` is one mount per image) so `uv python install`
  doesn't re-pull an interpreter per project either. `cli/src/images.ts`'s
  `IMAGE_CACHE` gains `'claude-web': { volume: 'cproj-uv-cache', mount:
  '/cache/uv' }`. Everything that reads `IMAGE_CACHE` generically (compose
  generation, `up`, the volume scan) already handles a second entry — this is
  additive, not a new mechanism. `library` shares the image and so shares the
  cache; harmless, it is unused unless a library project also uses Python.
- `cli/src/scaffold.ts`: `NODE_IGNORE` used by web/library gains Python's own
  churn (`.venv/`, `__pycache__/`, `*.pyc`) — a project's own venv lives under
  `/work` (bind-mounted, per-project, same reasoning as any other project
  file) and must not get committed or shipped in a build context.
- `docs/cli-spec.md` §4.3 table note and the Dockerfile's own comments record
  that `claude-web` now carries Python via `uv`; `CLAUDE.md`'s cache paragraph
  gets one line noting the second cache entry rather than a rewrite.
- Seeded `CLAUDE.md`'s dev-server note (`scaffold.ts`) gains one sentence for
  `web`/`library`: a second, unpublished process (e.g. a Python API on
  `localhost`) is reached by the frontend dev server's own proxy config, not
  by publishing a second port.

**Non-goals:** no new archetype, no second dev container, no compose schema
change, no attempt to model the backend as a catalogue "service" (it is the
project's own code, not a pullable image). No migration of *this project's*
`test/phase8.test.ts` android-only cache assertions beyond making them
correctly express "two images now declare a cache" instead of one.

**Done-check:** on a temp SSD, `new` a web project, `up` it, and inside the
container: `uv --version` succeeds; `uv python install 3.12 && uv run --python
3.12 python3 -c "print(1)"` succeeds; a package installed via `uv pip install`
populates `/cache/uv`; delete the project and create a second web project,
confirm the second container's `uv pip install` of the same package is served
from the cache with `--offline` (mirrors phase 8's Gradle offline proof).
`claude-ios`/`claude-and` containers still have no `uv` (boundary is the
image, not just documentation). Land as `test/phase11-done-check.sh` plus a
section in `test/regression.sh` (`LAST=11`).
