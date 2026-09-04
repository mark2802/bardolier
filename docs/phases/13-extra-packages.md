# Phase 13 — extra packages

**Goal:** Let a project declare OS-level packages its toolchain needs beyond
what a base image ships (e.g. Playwright's `libnss3`/`libatk`/… for
`install-deps`), so they persist across `stop`/`start` — without adding them
to the shared base image (every project would pay for them) or installing them
at runtime inside the container (no root there, and `down` throws the
container's writable layer away regardless). Root is used only at image-build
time, on the internal disk, exactly like the base images already are.

**Deliverables:**
- `project.yml` gains `extra_packages`, a sorted, deduped array of apt package
  names — `model/project.ts`, `project.schema.json`. Must be added to
  `workspace.ts`'s `orderManifest` whitelist (the phase 12 lesson: a field
  silently drops if it isn't).
- `cli/src/deps.ts` (new): the read model and the derived-image mechanics.
  - `derivedImageTag(baseImage, packages)` — `bandolier-deps-<baseImage>:<hash>`,
    `hash` a short sha256 of `baseImage + sorted packages`. Content-addressed
    (not per-project) so two projects declaring the same base image and
    package set share one image, the same reasoning as `IMAGE_CACHE`.
  - `derivedDockerfile(baseImage, packages, uid, gid)` — the generated
    Dockerfile text: `FROM <baseImage>:latest` → `USER root` → one
    `apt-get update && apt-get install -y --no-install-recommends <sorted
    packages> && rm -rf /var/lib/apt/lists/*` → `USER <uid>:<gid>` back to
    the identity the base image already switched to. No `ARG`s: the caller
    already has concrete uid/gid from `ctx.host`, unlike the base images
    which are built once for whoever runs `bandolier build`.
  - Written to `~/.config/bandolier/deps-images/<hash>/Dockerfile` — internal
    disk, alongside `config.yml`, not the SSD (disk frugality: images live on
    the internal disk full stop). Regenerated deterministically each time,
    same as `docker-compose.yml`; never hand-edited.
  - `attachedPackages(manifest)` — sorted list, for `deps list`.
- `cli/src/commands/deps.ts` (new): `deps add <project> <package...>` / `deps
  remove <project> <package...>` / `deps list <project>`, mirroring
  `service.ts`'s `requireStopped`/`persist` (imported, not duplicated) —
  add/remove require the project stopped, `PROJECT_RUNNING` otherwise. `list`
  is Docker-free, manifest only, like `service list`/`port list`. New error
  codes `PACKAGE_ATTACHED`/`PACKAGE_NOT_ATTACHED` for a redundant add/remove
  (parity with `SERVICE_ATTACHED`/`EXTRA_PORT_ATTACHED` — catches a typo'd
  re-add rather than silently no-op-ing). Package name argument validated
  against a conservative pattern (`^[a-z0-9][a-z0-9+.-]*$`, apt's own naming
  rule) — `INVALID_ARGUMENT` otherwise, since this string reaches a shell
  command inside the generated Dockerfile.
- `compose.ts`'s `devService()`: image becomes `derivedImageTag(...)` when
  `manifest.extra_packages` is non-empty, `${manifest.base_image}:latest`
  otherwise — one branch, same place the platform pin is already conditional.
- `up.ts`: new step between regenerating compose and validating ports — when
  `extra_packages` is non-empty, write the derived Dockerfile and call
  `ctx.docker.build` (tag/context/dockerfile/platform — reusing
  `IMAGE_PLATFORM[manifest.base_image]` for `bandolier-and` projects) *before*
  `composeUp`, since Compose references a local tag and never builds it
  itself. Docker's own build cache makes a repeat `up` with an unchanged
  package list and unchanged base image cheap — no existence check needed,
  the same reasoning that lets `composeUp`/`ensureVolume` stay unconditional.
  A build failure surfaces via the existing `DOCKER_UNAVAILABLE` path `ok()`
  already throws — no new error code for that.
- New schemas `deps-add`/`deps-remove`/`deps-list`; `project.schema.json`
  gains `extra_packages`.
- App: `DepsAddOutput`/`DepsRemoveOutput`/`DepsListOutput` in
  `BandolierModels.swift`; two new `BandolierErrorCode` constants.
- `cli-spec.md`: §4.2 (`extra_packages`), new §6 (Deps, alongside Services and
  Ports), §9 (image selection rule), §7 error list. `CLAUDE.md`'s "Extra ports
  are the same exception" paragraph gets a sibling paragraph for this.

**Non-goals:** no runtime/interactive installs and no `sudo`/`su` in any base
image — root stays confined to image-build time; no non-apt base images (all
three are Debian-family today, `apt-get` is assumed); no per-package version
pins (matches `extra_ports`' "declare after creation" precedent, not a lockfile);
no `status`/`up` JSON surfacing of `extra_packages` (`deps list` is the read
path — this is not a live resource the way a port or a running service is); no
pruning of superseded `bandolier-deps-*` images when a project's package list
changes — same as the tool doing nothing today about a stale `bandolier build`
output, left to `docker image prune`.

**Done-check:** on a temp SSD: `deps add` on a stopped `web` project, `up`
builds a derived image and the running container has the declared package
installed (verify via `docker exec … dpkg -s <pkg>`); a `down`/`up` cycle
keeps it installed without re-running `apt-get` (no root anywhere at runtime);
`deps add` while running fails `PROJECT_RUNNING`; a duplicate `deps add` fails
`PACKAGE_ATTACHED`; `deps remove` on an undeclared package fails
`PACKAGE_NOT_ATTACHED`; `deps remove` then `up` reverts to the plain base
image; an invalid package name fails `INVALID_ARGUMENT`; two projects on the
same base image with the same package list resolve to the same image tag.
Land as `test/phase13-done-check.sh` plus a section in `test/regression.sh`
(`LAST=13`); unit coverage in `test/phase13.test.ts`.
