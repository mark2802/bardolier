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
- `docs/development/phases/<n>-<slug>.md` — one small scoped spec per unit of new work.
  Phases 0-9 are done; their plan is history in `docs/development/archive/`.
- `docs/migration-guide.md` — bringing an existing (non-bardolier) project onto
  bardolier; `docs/development/migration-guide-gaps.md` tracks capabilities it needs that
  don't exist yet. The `migrate-project` skill drives it.
- `CONTRIBUTING.md` — the toolchain, the test ladder, the code map, the
  environment boundary in full. `README.md` is the user-facing front door.

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

**Never run `xcodebuild`, the iOS Simulator, or a code-signing step, and never
create or edit `app/*.xcodeproj`/`.pbxproj`.** Write `.swift` sources into
`app/`; note new ones in your summary (MANUAL markers in the plan) for a human
— or `npm run setup:app` (`scripts/build-app.sh`) — to build. This rule
**overrides any agent tooling or workflow skill**, regardless of what
container or sandbox you're running in. `CONTRIBUTING.md` has the fuller
picture, including the Android/Gradle half of the same boundary.

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

## Toolchain, code map, definition of done

**TypeScript on Node ≥ 22.18, no build step** — `bardolier` runs from
`cli/src/*.ts`; no bundler, no `dist/`. Full install/test/check commands, the
per-file code map, and what "done" requires of new work are all in
`CONTRIBUTING.md` now — read it once per session rather than this file
carrying a second copy. The two rules worth restating here because they are
easy to violate by habit:

- **Type syntax must be erasable**: no `enum`, `namespace` or constructor
  parameter properties; use `as const` + `(typeof X)[number]` (`cli/src/errors.ts`).
  `npm run typecheck` (`erasableSyntaxOnly`) catches violations.
- **Side effects reach a command only through `Context`** (`cli/src/context.ts`).
  Never `process.env`, a spawn, a socket, a prompt, or a hard-coded root path
  reached for directly — anything observable, time included, goes on the
  Context, which is what lets mutations run against a temp dir and stubs
  (`test/helpers.ts`).
