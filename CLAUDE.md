# CLAUDE.md — Container Project Manager

A CLI (`bardolier`) plus a macOS menu-bar app that manage containerised dev projects
whose data lives under one or more configured roots — typically an external SSD.

- `INTENT.md` — the owner's purpose, invariants, non-goals and settled
  decisions. **Read-only to you.**
- `docs/cli-spec.md` — the engine. **Authoritative for all behaviour**: layout
  §3, data model §4, ports §5, commands §6, `status` schema §7, config §8,
  compose §9, seeds §10, handoff §12.
- `docs/app-spec.md` — the menu-bar app; a thin client over the CLI. §15 maps
  the Swift sources.
- `docs/phases/<n>-<slug>.md` — one small scoped spec per unit of new work.
  Phases 0-9 are done; their plan is history in `docs/archive/`.
- `docs/migration-guide.md` — bringing an existing (non-bardolier) project onto
  bardolier; `docs/migration-guide-gaps.md` tracks capabilities it needs that
  don't exist yet.

This file holds only what the specs cannot: how to work here, the environment
boundary, and where the code is. **A rule about behaviour belongs in the spec.**
Read only the spec **section** a task needs (`sed -n` a range), not the whole file.

## Intent and decisions (read before planning)

- **`INTENT.md` belongs to the owner.** Quote it, never edit it. Check a phase's
  goal against its invariants before writing anything, and **raise** a conflict
  between intent and code rather than resolving it in either direction — a spec
  you maintain will otherwise follow the implementation silently.
- **Irreversible decisions leave the work item.** If reversing a choice would
  touch more than ~20 files — language, name, licence, storage layout, an
  on-disk or wire format — it is never a bullet inside a plan. Stop and ask; the
  answer lands in `INTENT.md`'s decision table before the phase that needs it.

## Token discipline

- **Read narrowly.** `grep`/`sed -n` a range over `cat` of a whole file; pipe
  long output through `tail`/`grep`. Never re-read a file you just wrote — the
  edit would have errored.
- **Test the smallest scope that can catch the bug**: `npm run test:quiet` (30
  lines, not 600) or the one done-check that owns what you touched.
  `regression.sh` runs them all and is for declaring work done;
  `BARDOLIER_SKIP_DOCKER=1` and `IMAGES_QUICK=1` skip legs a change cannot
  affect. Checks print failures and a summary (`VERBOSE=1` for every passing
  line). Never re-run a check that just passed.
- **Batch independent tool calls** into one message.
- **Don't add unasked work**: no extra docs, changelogs, formatting passes,
  review rounds, or subagents unless requested.
- **Budget prose.** Older comments and docs here run to essay length; *do not
  extend that style.* A non-obvious "why" gets a sentence or two, then stop; a
  summary states what changed and what proves it. A phase spec is one page, and
  this file only shrinks — an edit removes at least as much as it adds.

## Environment boundary (critical)

This project is developed in the split environment it manages. Claude runs in a
Linux dev container (source, CLI, tests, Docker CLI, Node/Bun, git). The human
works on the macOS host for anything macOS-native.

- **Never run `xcodebuild`, the iOS Simulator, or code signing.** You write
  `.swift` sources into `app/`; the human builds in Xcode.
- **You never create or edit `.xcodeproj`/`.pbxproj`.** Note new Swift files in
  your summary (MANUAL markers in the plan).
- Android Gradle builds/tests run in-container; the emulator is host-side.
- The same boundary is built into the images: the ios base has no `xcodebuild`,
  `xcrun` or simulator; the android base has no `adb` (`cli-spec.md` §4.3).
- These rules **override any agent tooling or workflow skill.**

## Engineering principles

- **The CLI is the API; the app is a thin client.** All orchestration, state and
  side effects live in the CLI. If the app seems to need logic, add a CLI
  command. Never duplicate orchestration in Swift.
- **One source of truth.** `project.yml`; compose, ports and orphans are all
  derived from the manifests, never recorded twice.
- **Prod-like dev topology.** The dev app reaches services over the Docker
  network by name (`postgres:5432`). An allocated host port is a debugging tap
  only — never wire the app to `localhost:<port>`. The exceptions are declared,
  not assumed: `app_port` and `extra_ports` (§5.1, §9).
- **Safety over convenience**, **disk frugality**, **determinism**, **no partial
  mutation of running state** — these are `INTENT.md` invariants; the spec says
  how each is enforced. Do not re-decide one inside a phase.
- **Drive the contract from the terminal**, via `--json`, before app work.

## Toolchain

**TypeScript on Node ≥ 22.18, no build step** — `bardolier` runs from
`cli/src/*.ts`; no bundler, no `dist/`.

- **Type syntax must be erasable**: no `enum`, `namespace` or constructor
  parameter properties; use `as const` + `(typeof X)[number]` (`cli/src/errors.ts`).
  `npm run typecheck` (`erasableSyntaxOnly`) catches violations.
- Import `.ts` extensions explicitly. npm workspace, so root-level `test/`
  resolves deps: `yaml`, `ajv` + `ajv-formats`, `node:test`.
- **A command never writes to stdout** — that keeps `--json` one JSON value.
  Declared in `commands/registry.ts`, returns a payload plus a human formatter;
  `main.ts` picks the renderer.
- **One definition, one schema, checked both ways**: `cli/src/model/<x>.ts` (or
  `errors.ts`, `config.ts`) ↔ `cli/schema/<x>.schema.json` via
  `test/contracts.test.ts`; `test/app-models.test.ts` binds the Swift structs to
  the same schemas. Not one file per command: `new`/`up`/`down`/`delete` →
  `model/lifecycle.ts`, `service *` → `model/service.ts`, `volumes *` →
  `model/volumes.ts`, `down-all`/`eject` → `model/ssd.ts`.
- **Side effects reach a command only through `Context`** (`cli/src/context.ts`):
  config, `Docker`, catalogue loader, host-port probe, `SsdDevice` (`lsof` +
  `diskutil`), confirm prompt, `Git`, host UID/GID, clock, `wait`. Never
  `process.env`, a spawn, a socket, a prompt, or a hard-coded root path. Anything
  observable — time included — goes on the Context; that is what lets mutations
  run against a temp dir and stubs (`test/helpers.ts`).
- `BARDOLIER_CONFIG` relocates the config file: how done-checks stay hermetic (§8).

```
npm install                             # once, from the repo root
npm run bardolier -- --help
node cli/bin/bardolier.js status --json
npm run test:quiet                      # contract tests — use this, not npm test
npm run typecheck
bash test/<name>-done-check.sh          # one function: services, eject, roots…
bash test/regression.sh [name...]       # every check, cheapest first, or just these
```

**A check is named for what it covers and stands alone.** Each builds its own
temp root and config (`test/lib.sh`), assumes nothing another check left, and
can run by itself — there is no ladder to walk. `contract` is the one that runs
`npm test` and the typecheck; `images` builds base images and runs Gradle under
emulation, so it goes last and is minutes rather than seconds.

## Code map

Behaviour is in `cli-spec.md`; this is only where to find it. A constant named
here is read by several files that must agree — change it in one place.

| File | Owns | Spec |
| --- | --- | --- |
| `layout.ts` | the four folders — `work`/`data`/`local`/`home` — created by `new`, re-ensured by every `up` | §3 |
| `compose.ts` | rendering; `PASSTHROUGH_ENV` — Compose **list** form, bare `NAME`, never `${NAME:-}`, which would inject an empty credential | §9 |
| `model/archetype.ts` | `ARCHETYPE_APP_PORT` — fixed inside the container, allocated on the host | §9 |
| `workspace.ts` | every write; skips one whose bytes already match | §9 |
| `allocator.ts` | manifest scan + host probe; free means both | §5 |
| `extraports.ts`, `deps.ts` | declared ports; declared apt packages and the content-addressed derived image | §5.1, §9 |
| `services.ts` | manifest ⋈ catalogue, so `status` and `service list` cannot disagree | §4.1 |
| `volumes.ts` | orphans, derived and never recorded; knows the shared cache by `bardolier.role: cache` | §6 |
| `device.ts` (`SsdDevice`) | `isActionableHolder`, `parseDissenter`; `commands/ssd.ts` drives down-all → holders → eject | §6 |
| `images.ts` | `IMAGE_PLATFORM` (`bardolier-and` is amd64), `IMAGE_CACHE` (shared gradle/uv caches), `CONTAINER_HOME` | §4.3, §9 |
| `transfer.ts` | staged copies: `.<name>.incoming`, renamed only once complete; space checked first | §6 |
| `handoff.ts` | the stop note; every part best-effort, none may fail the `down` | §12 |
| `cli/images/<image>/Dockerfile` | the three base images, built with `HOST_UID`/`HOST_GID`; Claude Code is the one unpinned component | §4.3, §6 |

## Definition of done

New work gets a scoped spec in `docs/phases/` and a terminal check; it is not
done until that check passes. The check joins the done-check for the function
it belongs to — a new one only for a function that has none — and stays. The
spec names any decision that must be answered first, and the check covers every
`INTENT.md` invariant the work could break.
