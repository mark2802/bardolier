# Phase 15 — the rename: CLI, docs, artefact namespaces

**Goal:** One name instead of two. `cproj` reads as a C-language tool and
`claude-yard` carries a trademark the project has no licence to; the three base
images (`claude-web`/`claude-ios`/`claude-and`) carry the same problem and are
user-visible in every `project.yml`. This phase renames everything on the CLI
side of the boundary, including the artefact namespaces Docker sees.

**Notation.** `<name>` is the chosen lowercase name — the binary, the npm
package, the config directory, the Docker label namespace and container/volume
prefix. `<NAME>` is its uppercase form (environment prefix); `<Name>` is the
capitalised form (Swift types and the app's display name, spent in phase 16).
**Choosing the name is the input this phase blocks on.**

**Grounding.** `cproj` appears in 133 files and `claude-yard` in 30. Most of
that is mechanical (`cproj`→`<name>`, `Cproj`→`<Name>`, `CPROJ_`→`<NAME>_`);
error codes are already name-free and need no thought. What is *not* mechanical
is the handful of strings Docker and the filesystem remember across the rename,
listed under Migration below.

**Deliverables:**
- Constants, one per module, each the single place its string is formed:
  `naming.ts` (`PREFIX`, `isCprojContainer`), `compose.ts`
  (`cproj.project`/`cproj.role`/`cproj.service`), `images.ts` (`IMAGE_CACHE`'s
  `cproj-uv-cache`/`cproj-gradle-cache`, `IMAGE_PLATFORM`'s key),
  `model/archetype.ts` (`BASE_IMAGES`, `ARCHETYPE_BASE_IMAGE`), `deps.ts`
  (the `cproj-deps-<base>` tag prefix and `~/.config/cproj/deps-images/`),
  `config.ts` (`CPROJ_SSD_ROOT`/`CPROJ_SSD_VOLUME`/`CPROJ_CONFIG`,
  `~/.config/cproj/config.yml`), `errors.ts` (`CprojError`), `handoff.ts` and
  `scaffold.ts` (`.cproj/`).
- `cli/images/claude-{web,ios,and}/` directories and their three Dockerfiles.
- `cli/schema/*.json`: `$id` (`https://cproj.local/schema/…`), titles,
  descriptions, and `project.schema.json`'s `base_image` enum.
- `cli/bin/cproj.js`; `cli/package.json` (`name`, `bin`, `scripts`); root
  `package.json` (`name`, `description`, `scripts.cproj`).
- Docs: `cli-spec.md`, `app-spec.md`, `migration-guide.md`,
  `migration-guide-gaps.md`, `CLAUDE.md`, `docs/development/archive/*`, **and every spec
  under `docs/development/phases/`, including 14 and 17–21 which have not been implemented
  yet** — they are written in the old name and must not carry it forward.
- Tests: `test/*.test.ts`, `test/*-done-check.sh`, `test/regression.sh`,
  `test/helpers.ts`.

**Migration (this developer's machine, once — documented in the phase, not
shipped as a command).** The rename orphans local state that Docker and the
filesystem key by the old strings:
- Named volumes. `<name>-<project>-home`, the two caches, and every service
  data volume must be copied (`docker run --rm -v old:/from -v new:/to alpine
  cp -a /from/. /to/`) or accepted as lost. `delete --purge` on the old names
  is the alternative for anything disposable.
- Manifests. `base_image: claude-web` no longer validates: `sed` every
  `project.yml` under the root before the first run.
- Config. `mv ~/.config/cproj ~/.config/<name>`.
- Images. `<name> build` rebuilds all three; the old `claude-*` and
  `cproj-deps-*` images are then `docker image rm` fodder.
- Containers need nothing — but note that `isCprojContainer` no longer matches
  them, so `down-all`'s stray sweep will walk past an old container. Stop them
  before renaming, not after.

**Non-goals:** no Swift and no `.xcodeproj` (phase 16, after the human's Xcode
step); no behaviour change of any kind; no change to the *shape* of the config
file (that is 17 and 18) — only the names of its keys' environment overrides
and its directory.

**Done-check:** `test/phase15-done-check.sh` asserts that `cproj`,
`claude-yard`, `CPROJ_` and `claude-{web,ios,and}` appear nowhere in the tree
outside `node_modules`/`.git`, and that `<name> --help`, `<name> status --json`
and a full `new` → `up` → `service add` → `status` → `down` → `delete`
lifecycle behave exactly as before. The real proof is the full suite
(`bash test/regression.sh`) green under the new name; add the grep assertion as
a section in `regression.sh`.
