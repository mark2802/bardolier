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
```

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

Commands are declared in `cli/src/commands/registry.ts` and return a payload
plus a human-formatting function; `cli/src/main.ts` picks the renderer. A command
must never write to stdout itself — that is what keeps the §2 guarantee that
`--json` emits exactly one JSON value.

**The outside world reaches commands through one seam.** A command takes a
`Context` (`cli/src/context.ts`) carrying the loaded config, a `Docker` handle,
a deferred catalogue loader, a host-port probe, a confirmation prompt, a host
UID/GID, and the clock — it never reads `process.env`, spawns `docker`, binds a
socket, prompts, or hard-codes the SSD path itself. That is what lets the whole
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

**Base images live in `cli/images/<image>/Dockerfile`** and are built by
`cproj build`, which passes `HOST_UID`/`HOST_GID` so files the dev container
writes into the bind-mounted `/work` come back owned by the Mac user. The
`claude-ios` and `claude-and` images land in Phase 8; until then `build` reports
them `unavailable` rather than failing.

- App: SwiftUI `MenuBarExtra`, `LSUIElement` = YES, App Sandbox off for v1.

## Definition of done (per phase)

Each phase has a terminal done-check in the implementation plan. A phase is not
done until its check passes. CLI phases' checks become regression scripts — keep
them.
