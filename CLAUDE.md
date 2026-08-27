# CLAUDE.md — Container Project Manager

A CLI (`cproj`) plus a macOS menu-bar app that manage containerised dev projects
whose data lives on an external SSD.

- `docs/cli-spec.md` — the engine. **Authoritative for all behaviour.**
- `docs/app-spec.md` — the menu-bar app; a thin client over the CLI.
- `docs/phases/<n>-<slug>.md` — one small scoped spec per unit of new work.
  Phases 0-9 are done; their plan is history in `docs/archive/`.
- `docs/migration-guide.md` — bringing an existing (non-cproj) project onto
  cproj; `docs/migration-guide-gaps.md` tracks capabilities it needs that
  don't exist yet.

Read only the spec **section** a task needs (`sed -n` a range), not the whole file.

## Token discipline (read first)

Recent work has cost far more tokens than the changes warranted. Rules:

- **Read narrowly.** `grep`/`sed -n` a range over `cat` of a whole file. Never
  re-read a file you just wrote — the edit would have errored.
- **Test the smallest scope that can catch the bug**: `npm test`, or the one
  phase check you touched. `test/regression.sh` is for declaring a phase done —
  prefer `--through N`; `PHASE8_QUICK=1` and `CPROJ_SKIP_DOCKER=1` skip legs a
  change cannot affect. Never re-run a check that just passed.
- **Quiet the noise.** `npm run test:quiet` over `npm test` (30 lines vs 600);
  done-checks print failures and a summary by default (`VERBOSE=1` for every
  passing line); pipe anything else long through `tail`/`grep`.
- **Batch independent tool calls** into one message.
- **Match prose to the change.** This repo's older comments, script headers and
  docs are written at essay length. *Do not extend that style.* Explain a
  non-obvious "why" in one or two sentences and stop. Summaries state what
  changed and what proves it — they do not re-narrate the diff.
- **Don't add unasked work**: no extra docs, changelogs, formatting passes,
  review rounds, or subagents unless requested.
- **Keep this file short.** A new principle edits or replaces an existing line;
  it does not append another essay.

## Environment boundary (critical)

This project is developed in the split environment it manages. Claude runs in a
Linux dev container (source, CLI, tests, Docker CLI, Node/Bun, git). The human
works on the macOS host for anything macOS-native.

- **Never run `xcodebuild`, the iOS Simulator, or code signing.** You write
  `.swift` sources into `app/`; the human builds in Xcode.
- **You never create or edit `.xcodeproj`/`.pbxproj`.** Note new Swift files in
  your summary (MANUAL markers in the plan).
- Android Gradle builds/tests run in-container; the emulator is host-side.
- These rules **override any agent tooling or workflow skill.**

## Engineering principles

- **The CLI is the API; the app is a thin client.** All orchestration, state and
  side effects live in the CLI. If the app seems to need logic, add a CLI
  command. Never duplicate orchestration in Swift.
- **One source of truth.** `project.yml` is the truth for a project; compose is
  generated from it. Ports live in the manifest, not a second registry.
- **Stable contracts.** Every command supports `--json`, emits a documented
  schema, and fails with a §2 error code. From Phase 5 on, schema changes are
  additive only. Human and machine output are separate renderers.
- **Determinism.** Compose generation is byte-stable for a given manifest.
- **No partial mutation of running state.** Service add/remove require the
  project stopped and fail `PROJECT_RUNNING`. No hot-apply paths.
- **Safety over convenience.** Detaching a service keeps its volume (it becomes
  a listed orphan); deletion is explicit and confirmed; eject reports holders
  rather than forcing. Never destroy data to save a step.
- **Disk frugality.** Images on the internal disk and shared; project data on
  the SSD. Prefer shared official service images over baking services in.
- **Prod-like dev topology.** The dev app reaches services over the Docker
  network by name (`postgres:5432`). The allocated host port is a debugging tap
  only — never wire the app to `localhost:<port>`.
- **Test the contract from the terminal**, via `--json`, before app work.
- **Incremental, verifiable changes.** Small commits, tests green, existing
  patterns over new ones.

## Toolchain

**TypeScript on Node, no build step.** Node ≥ 22.18 strips types, so `cproj`
runs from `cli/src/*.ts` — no bundler, no `dist/`. The cost: **type syntax must
be erasable** — no `enum`, no `namespace`, no constructor parameter properties;
use `as const` arrays plus `(typeof X)[number]` (see `cli/src/errors.ts`).
`erasableSyntaxOnly` makes `npm run typecheck` catch violations. Import `.ts`
extensions explicitly. The repo is an npm workspace so root-level `test/`
resolves dependencies. Dependencies are deliberately few: `yaml`, `ajv` +
`ajv-formats`; tests use `node:test`.

```
npm install                      # once, from the repo root
npm run cproj -- --help
node cli/bin/cproj.js status --json
npm run test:quiet               # contract tests (dot reporter — use this)
npm test                         # same, one line per test
npm run typecheck
bash test/phaseN-done-check.sh   # N = 0..9; each covers everything below it
bash test/regression.sh [--through N]   # every check, once, in order
```

**The ladder is walked once.** `regression.sh` owns the walk: each phase's
sections run once, in order, with `CPROJ_REGRESSION` set; a phase check seeing
that flag skips its own "earlier phases" section instead of recursing. 0–7 is
~60s; Phase 8 builds images and runs Gradle, so `--through 7` skips that.

**Contracts: one definition, one schema, checked both ways.** Each contract is
defined in `cli/src/model/<x>.ts` (or `errors.ts` / `config.ts`) and mirrored by
`cli/schema/<x>.schema.json`; `test/contracts.test.ts` holds them together, and
`test/app-models.test.ts` holds the Swift structs to the same schemas. Groupings
that aren't one-file-per-command: `new`/`up`/`down`/`delete` → `model/lifecycle.ts`,
`service *` → `model/service.ts`, `volumes *` → `model/volumes.ts`,
`down-all`/`eject` → `model/ssd.ts`. Commands are declared in
`cli/src/commands/registry.ts` and return a payload plus a human formatter;
`main.ts` picks the renderer. **A command must never write to stdout** — that is
what keeps `--json` a single JSON value.

**The outside world reaches commands through one seam.** A command takes a
`Context` (`cli/src/context.ts`): config, `Docker`, deferred catalogue loader,
host-port probe, `SsdDevice` (`lsof` + `diskutil`), confirm prompt, `Git`, host
UID/GID, clock, `wait`. It never touches `process.env`, spawns processes, binds
sockets, prompts, or hard-codes the SSD path. That is what lets mutations be
tested with a temp dir and stubs (`test/helpers.ts`). **Anything with an
observable side effect belongs on the Context**, including passing time. Config
comes from `~/.config/cproj/config.yml` with `CPROJ_SSD_ROOT` /
`CPROJ_SSD_VOLUME` overrides and `CPROJ_CONFIG` to relocate the file — which is
how done-checks stay hermetic.

## Behaviour that is easy to get wrong

**Generated vs seeded.** `docker-compose.yml` is rendered by `cli/src/compose.ts`
on every `new`, `up` and service change — never patched, never read back for
facts; a hand edit loses. The §10 seeds (`.gitignore`, `.dockerignore`, project
`CLAUDE.md`) are written once and are the user's. Writes go through
`cli/src/workspace.ts`, which skips a write when bytes match — determinism made
observable.

**Ports: chosen once, written once.** `cli/src/allocator.ts` scans every
manifest under `$SSD_ROOT` *and* probes the host socket — free means both. The
port persists in `project.yml` and is never revisited: `up` re-probes and fails
`PORT_UNAVAILABLE` naming it rather than remapping, because users have
connection strings. Search starts at the catalogue's `host_port_base`, bounded
to keep bands readable (§5). `cli/src/services.ts` joins manifest to catalogue,
so `status` and `service list` cannot disagree.

**An orphan is derived, never recorded.** `cli/src/volumes.ts` asks the
manifests what is still claimed (resolved volume name, plus the
`cproj.project`/`cproj.service` labels compose writes); everything else this
tool made is reclaimable. Because being wrong destroys data, the scan refuses
(`SSD_NOT_MOUNTED`, `CONFIG_INVALID`) when it cannot read manifests; `status`
catches that and reports an empty list, because `status` must never fail.

**`eject` never forces, and a holder is someone you can act on.** Stop
containers → ask `lsof` → unmount; a held volume is `EJECT_BLOCKED` carrying
`holders`. `isActionableHolder` excludes the container runtime (it keeps
descriptors on bind mounts after containers stop) and the OS volume agents
(`mds`, QuickLook — counting them made eject refuse forever on an indexed SSD).
Filtering is safe because both are DiskArbitration clients and the following
`diskutil eject` *is* the request to let go; a refusal is parsed by
`parseDissenter` into the same `holders` array — "close it" for Xcode, "try
again in a moment" for a system agent. Reduce a dissenter's name to its last
path component before classifying (recent macOS reports full executable paths).
`holders()` runs unprivileged, so a root dissenter is named there or nowhere.
**A blocked eject always names something.**

**Docker's VM gets a third answer: stop the engine, with consent.** Docker
Desktop shares `/Volumes` into its VM and holds descriptors while that VM lives
— nothing to close, no retry that works. When the runtime *alone* refused (named
by the dissenter, or via `device.runtimeHolders()`), `eject` asks and
`docker.stopEngine()` runs `docker desktop stop`. Consent is `--stop-docker` or
the prompt; no terminal means NO, i.e. `EJECT_BLOCKED` naming Docker. Then
**wait for the signal, not the command**: `docker desktop stop` returns before
launchd tears down the VM helper, so poll `device.runtimeHolders()` (bounded,
15s) until the runtime is off the volume, unmount, retry a runtime dissent twice
more. A spent budget is `EJECT_BLOCKED` with
`reason: 'runtime-holds-volume-after-stop'`, so the refusal cannot re-advise the
flag just used and the app withdraws the button. If lsof says the runtime let go
and the unmount still fails, relay diskutil's words untouched. Never force.

**Base images** live in `cli/images/<image>/Dockerfile`, built by `cproj build`
with `HOST_UID`/`HOST_GID` so bind-mounted `/work` files come back owned by the
Mac user. `claude-web` (Node), `claude-ios` (Swift + swiftlint), `claude-and`
(JDK, Android SDK, Gradle). No Dockerfile → `unavailable`, not an error.

**The boundary is built into the images.** The ios base has no `xcodebuild`,
`xcrun` or simulator; the android base has no `adb`. What they can do is §4.3:
`swift build`/`test`/`swiftlint`, Gradle builds and unit tests.

**One image is pinned to an architecture, in one place.** aapt2 is x86_64-only,
so `claude-and` builds and runs `linux/amd64` (emulated on Apple Silicon).
`IMAGE_PLATFORM` in `cli/src/images.ts` is the single constant — `build` turns
it into `--platform`, `compose.ts` into the dev service's `platform:`. Every
other image builds native and emits **no** `platform:` key.

**The Gradle cache is shared and is not project data.** `GRADLE_USER_HOME` is
`/cache/gradle`, a named volume (`cproj-gradle-cache`, `IMAGE_CACHE`) mounted
into every android dev container — hundreds of identical, re-downloadable
megabytes belong once, on the internal disk. Three readers must match the
constant: the Dockerfile `ENV`, the mount `compose.ts` writes, and `up`, which
creates the volume. Compose marks it `external: true` so no project stamps its
labels on it. `volumes.ts` knows it by `cproj.role: cache`: claimed while any
manifest names that base image, never taken by `delete --purge`.
`claude-web` carries the same for `uv`'s wheels (`cproj-uv-cache`,
`/cache/uv`) — a Python API and its React frontend run in one dev container,
no second port published; the dev server proxies to it (Phase 11).

**The agent ships in the base image.** All three install Claude Code — pinned
binary, checksum-verified, into `/usr/local/bin`. Not a catalogue service (the
catalogue is for sibling containers with an image, port and volume), and not
under `$HOME`, which is a mounted volume that would copy 236MB per project.

**`$HOME` is a volume, because `down` destroys the container.**
`CONTAINER_HOME` = `/state/home`, with `cproj-<project>-home` mounted there —
otherwise every stop loses shell history, dotfiles, and the `claude` login
(`$HOME/.claude`). It is **per project**: Claude Code files sessions by working
directory and every container works in `/work`, so one shared home would make
`claude --continue` resume whichever project ran last. Four readers must agree
(the constant and three Dockerfiles). `delete --purge` takes it; plain `delete`
leaves it an orphan.

**The host is lent, never copied.** `PASSTHROUGH_ENV` in `compose.ts` uses
Compose's **list** form (bare `NAME`, no `=`) — the only shape meaning "pass
through if set, otherwise leave unset". `${NAME:-}` would inject an empty
credential, i.e. a failing login instead of a prompt. Fixed and sorted, so the
file is byte-identical on a Mac holding every token and one holding none. `up`
fills `GIT_*` from the host's `git config` through the `Git` seam. No credential
is ever written to `config.yml`.

**The dev container publishes exactly one *fixed* thing, plus what's declared.**
`ARCHETYPE_APP_PORT`: fixed inside the container (3000, with `PORT` set),
allocated from a host band and persisted as `app_port`, assigned once and never
revisited. Projects predating the field get one on their next `up`. This is
the first exception to "a published port is a debugging tap" — a browser on
the Mac cannot join the Docker network. `status` reports `app_url`, as it
reports `connection_hint`.

**Extra ports are the same exception, opted into by name.** `cproj port
add <project> <name> --container-port <n>` (§5.1, `cli/src/extraports.ts`)
declares a port independent of archetype — no catalogue, no image, no volume,
just a name and two port numbers persisted under `extra_ports` and published
in compose alongside `app_port`. It closes two gaps: a mobile client or a
second UI app that must reach a project's own process directly (not just the
browser, which can go through the frontend dev server's proxy config instead),
and a browser-reachable dev tool on `library`/`ios`/`android`, which otherwise
publish nothing at all. Allocated like `app_port` — search starts at
`--container-port` itself, no band to inherit from a catalogue that doesn't
apply. `port add`/`remove` require the project stopped, same as `service`.

**`down` writes down where you were.** `cli/src/handoff.ts` writes
`.cproj/handoff.md` on every stop: repository state from `Git`, plus the agent's
own account via `claude --print --continue` **inside the still-running dev
container** — after `compose down` there is nobody to ask. Everything is
best-effort: missing container, agent, session or credentials, a timeout, or a
read-only disk degrades the note and never fails the stop. A non-zero exit or
empty output is reported as such, not pasted under the heading. `delete` skips
it.

**Two commands exist because the app asked.** `cproj catalogue` and
`cproj config get|set` are Phase 6 additions under §1's rule that the CLI grows
to serve the app — the alternative was a copy of `services.yml` in Swift and a
second config writer that knew only some of §8's precedence rules. `status`
gained `dir` the same way, so the app never composes a path from `ssd.root`.

## The app

**It reads the contract; it never re-derives it.** `app/claude-yard/claude-yard/Cproj/`:
`CprojClient` builds argv, appends `--json` itself (no caller may), and turns a
non-zero exit into `CprojFailure.cli` with the §2 code. `CprojModels.swift`
mirrors `cli/schema/*.json`, one struct per schema object; closed string enums
decode as open tokens so additive changes can't break an older build.
`test/app-models.test.ts` checks it as text in both directions — a missed field,
an invented one, an impossible error code, or a `Process` spawned outside the
client fails there. A GUI app inherits no shell `PATH`, so
`CprojExecutable.swift` locates `cproj` and hands the child a `PATH` reaching
`node`, `docker`, `lsof`, `diskutil` — the only environment knowledge in Swift.

- **A blocked eject is a place to come back to.** `CprojStore.ejectPhase` holds
  blocked/working/ejected/failed (not `lastError`, which the next refresh
  clears); `EjectPanel` renders it, offers **Retry** (the same call again), and
  the menu row says where the flow got to. Nothing in Swift can force an unmount
  or kill a holder, and `eject` has no `--force` (`test/phase7.test.ts`).
- **A dimmed row and an absent row look the same.** `MenuRow` takes a
  `disabledReason` and serves it as help; `DisabledNotice` says it once per
  group — with Docker down, every mutating item is disabled for one reason.
- **A missing `cproj` is the state of the whole menu.** `CprojStore.cprojMissing`
  shows `FirstRunPanel` — listing the paths `CprojExecutable` actually searched
  — instead of letting each item fail its own way (§13).
- **One operation at a time, then ask.** `CprojStore.activity` names it; while
  set, mutating items are disabled, and every mutation is followed by a forced
  `status` refresh rather than a local patch (§4). Refusals are relayed verbatim
  — `PROJECT_RUNNING` becomes "Stop the project to change its services", never
  an unrequested stop-change-start. Destructive confirmation happens in the view
  before the call, because the client passes `--force` and the CLI cannot prompt.
  `CprojTerminal` runs `cproj shell`'s argv via AppleScript or a `.command` file
  and launches no process itself.
- Build settings the human sets in Xcode (`app/README.md`): SwiftUI
  `MenuBarExtra`, `LSUIElement` YES, App Sandbox off for v1,
  `NSAppleEventsUsageDescription` (without it macOS kills the app on first
  terminal drive). The target uses a synchronized folder group, so new `.swift`
  files build without an Add-Files step.

## Definition of done

New work gets a scoped spec in `docs/phases/` and a terminal done-check; it is
not done until that check passes, and a CLI check then joins `regression.sh`
and stays.
