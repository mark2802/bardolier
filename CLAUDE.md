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
- **One acceptance criterion per phase is the owner's**, written before the work
  and observable from outside the code. Checks you write test internal
  self-consistency; they cannot test intent.
- **Size by review capacity, not output rate.** One command or one seam per
  commit, ~400 lines of new logic. If it cannot be reviewed today, it is not
  started today.
- **Use beats reading.** Putting a real project through a change (the migration
  guide) finds gaps that spec review does not — phases 12 and 13 came from it.
- **Freeze the envelope, not the payload.** Error codes and the single-JSON-value
  rule are stable; a payload shape is stable once something real has run against it.

## Token discipline

- **Read narrowly.** `grep`/`sed -n` a range over `cat` of a whole file. Never
  re-read a file you just wrote — the edit would have errored.
- **Test the smallest scope that can catch the bug**: `npm test`, or the one
  phase check you touched. `test/regression.sh` is for declaring a phase done —
  prefer `--through N`; `PHASE8_QUICK=1` and `BARDOLIER_SKIP_DOCKER=1` skip legs a
  change cannot affect. Never re-run a check that just passed.
- **Quiet the noise.** `npm run test:quiet` over `npm test` (30 lines vs 600);
  done-checks print failures and a summary by default (`VERBOSE=1` for every
  passing line); pipe anything else long through `tail`/`grep`.
- **Batch independent tool calls** into one message.
- **Match prose to the change.** Older comments and docs here run to essay
  length. *Do not extend that style.* Explain a non-obvious "why" in a sentence
  or two and stop. Summaries state what changed and what proves it.
- **Don't add unasked work**: no extra docs, changelogs, formatting passes,
  review rounds, or subagents unless requested.
- **Budget prose.** A phase spec is one page; this file targets ~100 lines and
  only shrinks — an edit removes at least as much as it adds.

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
- **One source of truth.** `project.yml` is the truth for a project; everything
  else — compose, ports, orphans — is generated or derived from the manifests.
- **Prod-like dev topology.** The dev app reaches services over the Docker
  network by name (`postgres:5432`). An allocated host port is a debugging tap
  only — never wire the app to `localhost:<port>`. The exceptions are declared,
  not assumed: `app_port` and `extra_ports` (§5.1, §9).
- **Safety over convenience**, **disk frugality**, **determinism**, **no partial
  mutation of running state** — these are `INTENT.md` invariants; the spec says
  how each is enforced. Do not re-decide one inside a phase.
- **Test the contract from the terminal**, via `--json`, before app work.

## Toolchain

**TypeScript on Node, no build step.** Node ≥ 22.18 strips types, so `bardolier`
runs from `cli/src/*.ts` — no bundler, no `dist/`. The cost: **type syntax must
be erasable** — no `enum`, no `namespace`, no constructor parameter properties;
use `as const` arrays plus `(typeof X)[number]` (see `cli/src/errors.ts`).
`erasableSyntaxOnly` makes `npm run typecheck` catch violations. Import `.ts`
extensions explicitly. The repo is an npm workspace so root-level `test/`
resolves dependencies. Dependencies are deliberately few: `yaml`, `ajv` +
`ajv-formats`; tests use `node:test`.

```
npm install                      # once, from the repo root
npm run bardolier -- --help
node cli/bin/bardolier.js status --json
npm run test:quiet               # contract tests (dot reporter — use this)
npm run typecheck
bash test/phaseN-done-check.sh   # N = 0..9; each covers everything below it
bash test/regression.sh [--through N]   # every check, once, in order
```

**The ladder is walked once.** `regression.sh` owns the walk: each phase's
sections run once, in order, with `BARDOLIER_REGRESSION` set; a phase check seeing
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
sockets, prompts, or hard-codes a root path — which is what lets mutations be
tested with a temp dir and stubs (`test/helpers.ts`). **Anything with an
observable side effect belongs on the Context**, including passing time.
`BARDOLIER_CONFIG` relocates the config file, which is how done-checks stay
hermetic (§8).

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
| `device.ts` (`SsdDevice`) | `isActionableHolder`, `parseDissenter`; `commands/ssd.ts` drives down-all → holders → eject, with the bounded wait after `docker desktop stop` | §6 |
| `images.ts` | `IMAGE_PLATFORM` (`bardolier-and` is amd64), `IMAGE_CACHE` (shared gradle/uv caches), `CONTAINER_HOME` — this constant plus three Dockerfiles must agree | §4.3, §9 |
| `handoff.ts` | the stop note; every part best-effort, none may fail the `down` | §12 |
| `cli/images/<image>/Dockerfile` | the three base images, built with `HOST_UID`/`HOST_GID`; Claude Code is the one unpinned component | §4.3, §6 |

## Definition of done

New work gets a scoped spec in `docs/phases/` and a terminal done-check; it is
not done until that check passes, and a CLI check then joins `regression.sh`
and stays. The spec names the owner's acceptance criterion and any decision that
must be answered first; the check covers that criterion and any `INTENT.md`
invariant the work could break.
