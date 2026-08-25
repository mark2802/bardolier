# CLAUDE.md — Container Project Manager

This project builds a CLI (`cproj`) and a macOS menu-bar app that manage
containerised dev projects whose data lives on an external SSD.

## Read these first

- `docs/cli-spec.md` — the engine. **Authoritative for all behaviour.**
- `docs/app-spec.md` — the menu-bar app; a thin client over the CLI.
- `docs/implementation-plan.md` — phased build. Work one phase per `/goal`.

When a phase goal is given, read the relevant spec section for that phase and the
principles below before writing code.

## Environment boundary (critical)

This project is itself developed in the split environment it manages:

- **You (Claude) run in a Linux dev container**, sandboxed to this project
  directory. You can: edit source, run the CLI and its tests, run Docker-CLI
  commands against the daemon, run Node/Bun tooling, use git.
- **The human works on the macOS host** for anything macOS-native.

Hard rules:
- **Never attempt `xcodebuild`, the iOS Simulator, or code signing.** Xcode is
  macOS-only and absent here. The menu-bar app is built by the human in Xcode;
  you only write its `.swift` source files into `app/`.
- **Creating or modifying the Xcode project file is a human step.** You do not
  create `.xcodeproj`/`.pbxproj`. When you add Swift files, note in your summary
  that the human must add them to the Xcode target (see the implementation plan's
  MANUAL markers).
- For **Android** archetype projects this tool manages, Gradle builds/tests can
  run in-container, but the emulator is host-side.
- These boundary rules **override any agent tooling or workflow skill.** If any
  command or skill assumes a full local build environment, defer to these rules —
  do not run host-only build steps in the container.

## Engineering principles

**The CLI is the API; the app is a thin client.** All orchestration, state, and
side effects live in the CLI. The app only invokes commands and renders JSON. If
the app appears to need logic, add a CLI command instead. Never duplicate
orchestration in Swift.

**One source of truth.** Per-project `project.yml` is the truth for that project;
the compose file is *generated* from it and never hand-edited. Port assignments
live in the manifest, not a separate registry. Don't introduce a second store
that can desync.

**Stable contracts.** Every CLI command supports `--json`, emits a documented
schema, and returns a stable error code on failure (`cli-spec.md` §2, §7). Once
the app is built (Phase 5+), schema changes are additive only. Human-readable
output and machine output are separate renderers; never make the app parse human
output.

**Determinism.** Compose generation must be deterministic for a given manifest
(stable ordering) so regeneration yields no spurious diffs. Same input, same
output.

**No partial mutation of running state.** Service add/remove require the project
stopped and fail `PROJECT_RUNNING`. This keeps state machines simple — honour it;
do not add hot-apply paths.

**Safety over convenience for destructive actions.** Detaching a service keeps
its data volume (it becomes a listed orphan); deletion is explicit and confirmed.
Eject refuses when the SSD is held and reports the holders rather than forcing.
Never destroy data to save a step.

**Disk frugality.** Docker images live on the internal disk and are shared;
project data lives on the SSD. Seed `.dockerignore` and `.gitignore` so build
context and repos stay lean. Prefer shared official service images over baking
services into the base.

**Prod-like dev topology.** The dev app connects to services over the internal
Docker network by service name (e.g. `postgres:5432`), matching production. The
allocated host port is a **debugging tap only** (for host GUI tools). Never wire
the app to `localhost:<port>` for its normal service connections — that would
diverge dev from prod.

**Test the contract from the terminal.** The full lifecycle must be drivable and
assertable via `--json` before any app work (implementation plan, Phase 4 gate).
Port allocation gets unit tests: uniqueness, stability across restart, band
assignment, host-squat detection.

**Incremental, verifiable changes.** Small commits that keep the CLI runnable and
its tests green. Prefer clarity over cleverness. Read existing patterns before
adding new ones.

## Toolchain

**CLI: TypeScript on Node — no build step.** Chosen in Phase 0. Node ≥ 22.18
strips TypeScript types natively, so `cproj` runs straight from `cli/src/*.ts`.
There is no bundler, no `dist/`, and nothing to rebuild after an edit.

The cost of that: **type syntax must be erasable**. No TS `enum`, no `namespace`,
no constructor parameter properties. Use `as const` arrays plus
`(typeof X)[number]` for unions — see `cli/src/errors.ts`. `tsconfig.json` sets
`erasableSyntaxOnly` so `npm run typecheck` catches violations.

Import `.ts` extensions explicitly (`import { … } from './errors.ts'`) —
required by Node's resolver.

The repo is an **npm workspace** so `test/` can sit at the root (per the
implementation plan's layout) and still resolve dependencies.

```
npm install                      # once, from the repo root
npm run cproj -- --help          # run the CLI (note the `--`)
node cli/bin/cproj.js status --json
npm test                         # contract tests (node:test, no framework dep)
npm run typecheck                # tsc --noEmit
bash test/phase0-done-check.sh   # Phase 0 regression check
bash test/phase1-done-check.sh   # Phase 1 regression check (runs Phase 0's too)
bash test/phase2-done-check.sh   # Phase 2 regression check (runs 0 and 1 too)
bash test/phase3-done-check.sh   # Phase 3 regression check (runs 0-2 too)
bash test/phase4-done-check.sh   # Phase 4 regression check (runs 0-3 too) — the
                                 # contract-freeze gate: schemas are additive-only
                                 # from here
bash test/phase5-done-check.sh   # Phase 5: the app's models against the frozen
                                 # schemas, plus 0-4. Its other half is manual,
                                 # in Xcode; the script prints that checklist
bash test/phase6-done-check.sh   # Phase 6: the commands the app needed, the
                                 # sources, the build settings, and (only when a
                                 # Swift toolchain is present) a type-check and
                                 # an SF Symbol check. Its other half — the
                                 # lifecycle driven from the menu bar — is the
                                 # checklist it prints
bash test/phase7-done-check.sh   # Phase 7: the two flows that leave the app —
                                 # shell-open and eject. Drives the eject flow
                                 # through the context seam with a scripted
                                 # device (a done-check must never reach a real
                                 # `diskutil`); its other half is a soak with a
                                 # real disk and a real Xcode, which it prints
bash test/phase8-done-check.sh   # Phase 8: the mobile base images, for real —
                                 # it builds them if they are missing, then
                                 # drives an ios and an android project through
                                 # `new`/`up` and works inside the container:
                                 # swift build/test + swiftlint, and a Gradle
                                 # assembleDebug + unit test that must produce
                                 # an APK owned by you. It needs the network and
                                 # its Gradle leg is emulated on Apple Silicon;
                                 # PHASE8_QUICK=1 keeps everything but the two
                                 # toolchain runs
bash test/regression.sh          # every phase's check, each run ONCE, in order
bash test/regression.sh --through 7   # …up to a phase (7 skips Phase 8's
                                 # image builds and Gradle run: ~1 minute)
```

**The ladder is walked once.** Each phase's check used to end by re-running all
of its predecessors — and each of those did the same, so phase 0's containers
came up dozens of times per invocation and `phase7-done-check.sh` took the
better part of an hour for a minute of distinct work. `test/regression.sh` now
owns that walk: it runs each phase's own sections in order, exactly once, with
`CPROJ_REGRESSION` set, and a phase check that sees that flag skips its own
"earlier phases" section instead of recursing. Run a phase check on its own and
it still covers everything below it — it just asks the runner rather than
rebuilding the pyramid. Same coverage, linear cost (0-7 is ~60s).

Dependencies are deliberately few: `yaml` (manifests + catalogue), `ajv` +
`ajv-formats` (schema validation). Tests use the built-in `node:test` runner.

**Where the contracts live** — one definition each, mirrored by a JSON Schema
that `test/contracts.test.ts` checks against the code:

| Contract | Code | Schema |
|---|---|---|
| Error codes (§2) | `cli/src/errors.ts` | `cli/schema/error.schema.json` |
| Service catalogue (§4.1) | `cli/src/model/catalogue.ts` | `cli/schema/services.schema.json` |
| Project manifest (§4.2) | `cli/src/model/project.ts` | `cli/schema/project.schema.json` |
| Archetype map (§4.3) | `cli/src/model/archetype.ts` | — |
| `status` output (§7) | `cli/src/model/status.ts` | `cli/schema/status.schema.json` |
| `list` output (§6) | `cli/src/model/list.ts` | `cli/schema/list.schema.json` |
| `doctor` output (§6) | `cli/src/model/doctor.ts` | `cli/schema/doctor.schema.json` |
| Config file (§8) | `cli/src/config.ts` | `cli/schema/config.schema.json` |
| `new` output (§6) | `cli/src/model/lifecycle.ts` | `cli/schema/new.schema.json` |
| `up` output (§6) | `cli/src/model/lifecycle.ts` | `cli/schema/up.schema.json` |
| `down` output (§6) | `cli/src/model/lifecycle.ts` | `cli/schema/down.schema.json` |
| `delete` output (§6) | `cli/src/model/lifecycle.ts` | `cli/schema/delete.schema.json` |
| `build` output (§6) | `cli/src/model/build.ts` | `cli/schema/build.schema.json` |
| `service add` output (§6) | `cli/src/model/service.ts` | `cli/schema/service-add.schema.json` |
| `service remove` output (§6) | `cli/src/model/service.ts` | `cli/schema/service-remove.schema.json` |
| `service list` output (§6) | `cli/src/model/service.ts` | `cli/schema/service-list.schema.json` |
| `shell` output (§6) | `cli/src/model/shell.ts` | `cli/schema/shell.schema.json` |
| `volumes orphaned` output (§6) | `cli/src/model/volumes.ts` | `cli/schema/volumes-orphaned.schema.json` |
| `volumes rm` output (§6) | `cli/src/model/volumes.ts` | `cli/schema/volumes-rm.schema.json` |
| `down-all` output (§6) | `cli/src/model/ssd.ts` | `cli/schema/down-all.schema.json` |
| `eject` output (§6) | `cli/src/model/ssd.ts` | `cli/schema/eject.schema.json` |
| `catalogue` output (§4.1) | `cli/src/model/catalogue.ts` | `cli/schema/catalogue.schema.json` |
| `config get` output (§8) | `cli/src/model/config.ts` | `cli/schema/config-get.schema.json` |
| `config set` output (§8) | `cli/src/model/config.ts` | `cli/schema/config-set.schema.json` |

Commands are declared in `cli/src/commands/registry.ts` and return a payload
plus a human-formatting function; `cli/src/main.ts` picks the renderer. A command
must never write to stdout itself — that is what keeps the §2 guarantee that
`--json` emits exactly one JSON value.

**The outside world reaches commands through one seam.** A command takes a
`Context` (`cli/src/context.ts`) carrying the loaded config, a `Docker` handle,
a deferred catalogue loader, a host-port probe, an `SsdDevice` (`lsof` +
`diskutil`, `cli/src/device.ts`), a confirmation prompt, a host UID/GID, and the
clock — it never reads `process.env`, spawns `docker` or `lsof`, binds a socket,
prompts, or hard-codes the SSD path itself. That is what lets the whole
CLI, mutations included, be tested with a temp dir for the SSD and stubs for the
rest (`test/helpers.ts`). Anything with an observable side effect belongs on the
Context, or the tests stop being honest. Config is read from
`~/.config/cproj/config.yml` with `CPROJ_SSD_ROOT` / `CPROJ_SSD_VOLUME`
overrides (§8), plus `CPROJ_CONFIG` to relocate the file itself — which is how
the done-checks stay hermetic on a real machine.

**Generated files are regenerated, seeded files are not.** `docker-compose.yml`
is rendered from `project.yml` by `cli/src/compose.ts` on every `new`, `up`, and
service change; it is never patched, never read back for facts, and a hand edit
loses. The §10 seeds (`.gitignore`, `.dockerignore`, project `CLAUDE.md`) are
written once by `new` and are the user's from then on. Writing goes through
`cli/src/workspace.ts`, which also skips the write when the bytes already match —
that is what makes determinism observable rather than merely intended.

**Ports are chosen in one place and written down in one place.**
`cli/src/allocator.ts` picks a host port by scanning every manifest under
`$SSD_ROOT` and then probing the host socket — a port is free only when both say
so. The chosen port is persisted in the project's `project.yml` and never
revisited: `up` re-probes and fails `PORT_UNAVAILABLE` naming the port rather
than remapping it, because the user has connection strings saved against it. The
search starts at the catalogue's `host_port_base` and is bounded to keep bands
readable (§5). `cli/src/services.ts` joins manifest to catalogue to describe an
attachment; `status` and `service list` both go through it, so they cannot
describe the same attachment differently.

**An orphan is derived, never recorded.** `cli/src/volumes.ts` asks the
manifests under `$SSD_ROOT` what is still claimed — by resolved volume name, and
by the `cproj.project`/`cproj.service` labels the generated compose file writes
— and everything else this tool made is reclaimable. There is no orphan
registry to desync. Because being wrong here destroys data, the scan refuses
(SSD_NOT_MOUNTED, CONFIG_INVALID) when it cannot read the manifests rather than
calling every volume an orphan; `status` catches that and reports an empty list,
because `status` must never fail.

**`eject` never forces.** It stops containers, asks `lsof` who still holds the
volume, then unmounts — and a held volume is `EJECT_BLOCKED` carrying `holders`
for the app to render. The one exception to "report every holder" is the
container runtime's own descriptors (`isRuntimeHolder`), which Docker Desktop
keeps open on bind-mounted paths after its containers stop; listing those would
make "quit Docker" the standing answer to every eject. If the volume genuinely
will not go, `diskutil`'s own refusal is reported as it came.

**Base images live in `cli/images/<image>/Dockerfile`** and are built by
`cproj build`, which passes `HOST_UID`/`HOST_GID` so files the dev container
writes into the bind-mounted `/work` come back owned by the Mac user. All three
exist: `claude-web` (Node), `claude-ios` (the Swift toolchain plus swiftlint)
and `claude-and` (JDK, Android SDK, Gradle). An image with no Dockerfile behind
it is still reported `unavailable` rather than failing — that state now means a
missing file, not an unfinished phase.

**The boundary is built into the mobile images, not just written down.** The
ios base has no `xcodebuild`, `xcrun` or simulator and the android base no
`adb`, so the host-only steps the seeded `CLAUDE.md` forbids cannot be attempted
from inside — advice the container cannot disobey. What each CAN do is what
§4.3 promises: `swift build`/`swift test`/`swiftlint` there, Gradle builds and
unit tests here.

**One image is pinned to an architecture, in one place.** Google ships the Linux
Android SDK build tools (aapt2) for x86_64 only, so `claude-and` is built and
run `linux/amd64` — emulated on Apple Silicon, which is slower but is the
difference between building and not. `IMAGE_PLATFORM` in `cli/src/images.ts` is
the single constant; `build` turns it into `--platform` and `compose.ts` into
the dev service's `platform:`, because an image built for one platform and
started on another either fails or silently pulls a different image. Every other
image builds for whatever the Mac is, and emits no `platform:` key — an unpinned
project's generated compose file must not change.

**Two commands exist because the app asked, not because §6 named them.**
`cproj catalogue` and `cproj config get|set` are Phase 6 additions under §1's
rule that "if the app needs something, a CLI command grows to provide it". The
Services submenu ticks the attached rows of the WHOLE catalogue and the
New-project window offers the same list, so the alternative was a copy of
`services.yml` in Swift; Preferences writes the SSD path and the terminal, so
the alternative was a second writer that knew only some of §8's precedence and
path-expansion rules. Both are additive — no frozen schema changed to make room
for them — and `status` gained `dir` the same way, so "Open folder in Finder"
never composes a path out of `ssd.root`.

**The app reads the contract; it never re-derives it.** The Swift client lives
in `app/claude-yard/claude-yard/Cproj/` — `CprojClient` builds argv, appends
`--json` itself (no caller may), runs the binary, and turns a non-zero exit into
`CprojFailure.cli` carrying the stable §2 code. `CprojModels.swift` mirrors
`cli/schema/*.json` one struct per schema object; closed string enums decode as
open tokens so an additive schema change cannot break an older build. Because
Xcode is host-only and `npm test` compiles no Swift,
`test/app-models.test.ts` reads it as text and holds it to the same schemas in
both directions — a required field missed, a field invented, an error code the
CLI cannot emit, or a `Process` spawned outside the client all fail there rather
than in the menu bar. A GUI app inherits no shell `PATH`, so
`CprojExecutable.swift` locates `cproj` and hands the child a `PATH` that can
find `node`, `docker`, `lsof` and `diskutil`; that is the only environment
knowledge in Swift.

**A blocked eject is a place to come back to, not a banner.** `cproj eject`
answers EJECT_BLOCKED with `holders`, and the user's next move is to leave, quit
Xcode, and try again — so `CprojStore.ejectPhase` holds that state (blocked with
its holders, working, ejected, failed) instead of `lastError`, which the next
refresh clears. `EjectPanel` renders the phase, offers **Retry** — which is
simply the same call again — and the menu row says where the flow got to, so
closing the popover loses nothing. Nothing in Swift can force an unmount or kill
a holder, and there is no `--force` on `eject` to reach for
(`test/phase7.test.ts`).

**A missing `cproj` is the state of the whole menu.** With nothing to run there
is no status to show and no action to offer, so `CprojStore.cprojMissing` puts
`FirstRunPanel` in place of the menu — with the locations
`CprojExecutable` actually searched, not a plausible-looking list — rather than
letting each item fail its own way (`app-spec.md` §13).

**The menu runs one thing at a time, and asks after each.** `CprojStore` names
the running operation in `activity`; while it is set every mutating item is
disabled, and every mutation is followed by a forced `status` refresh rather
than a patch to the store's own copy (`app-spec.md` §4). A refusal is relayed
verbatim — PROJECT_RUNNING on a service change becomes "Stop the project to
change its services", never a stop-change-start the user did not ask for.
Confirmation for anything destructive happens in the VIEW before the call,
because `CprojClient` passes `--force` and the CLI cannot prompt with no
terminal. `CprojTerminal` runs `cproj shell`'s argv in the user's terminal
through AppleScript or a `.command` file — it launches no process of its own,
so `CprojClient` remains the only thing in the app that constructs one.

- App: SwiftUI `MenuBarExtra`, `LSUIElement` = YES, App Sandbox off for v1, plus
  `NSAppleEventsUsageDescription` from Phase 6 (without it macOS terminates the
  app the first time it drives a terminal). All are build settings the human sets
  in Xcode (`app/README.md`); the target uses a synchronized folder group, so
  `.swift` files written to disk are in the build without an "Add Files to
  target" step.

## Definition of done (per phase)

Each phase has a terminal done-check in the implementation plan. A phase is not
done until its check passes. CLI phases' checks become regression scripts — keep
them.
