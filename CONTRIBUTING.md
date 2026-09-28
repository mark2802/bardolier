# Contributing

Thanks for looking at bardolier. This is how to build it, test it, and where
things live — `CLAUDE.md` covers the rest (doc map, engineering principles,
per-file code map) for whichever agent is working in the repo alongside you.

## The split environment

This project manages a split setup — a Mac host driving Linux containers —
and its own development mirrors that. The original development of this
project ran with an AI coding agent working from a Linux dev container
(source, the CLI, tests, the Docker CLI, Node, git) while a human did
anything macOS-native from the host. You don't have to reproduce that split
exactly, but two rules hold regardless of how you work:

- **Nothing but Xcode edits `app/*.xcodeproj`/`.pbxproj`, and nothing but a
  human (or a host-side script) runs `xcodebuild`, the iOS Simulator, or a
  code-signing step.** Swift sources under `app/` can be written from
  anywhere; the project file and the build itself are host-only. `npm run
  setup:app` (`scripts/build-app.sh`) automates the host half without
  opening Xcode — see the README's Install section.
- **Android Gradle builds and tests run wherever Node/Docker run**; only the
  emulator itself is host-side. The same boundary is built into the base
  images: the `ios` image has no `xcodebuild`/`xcrun`/simulator, the
  `android` image has no `adb` (`cli-spec.md` §4.3).

If you're pairing with an agent that has its own sandbox or container, tell
it these two rules explicitly — they override whatever its default tooling
assumes.

## Toolchain

**TypeScript on Node ≥ 22.18, no build step** — `bardolier` runs straight
from `cli/src/*.ts`; there is no bundler and no `dist/`.

```sh
npm install                             # once, from the repo root
npm run bardolier -- --help
node cli/bin/bardolier.js status --json
npm run test:quiet                      # contract tests — use this, not npm test
npm run typecheck
bash test/<name>-done-check.sh          # one function: services, eject, roots…
bash test/regression.sh [name...]       # every check, cheapest first, or just these
```

- **Type syntax must be erasable**: no `enum`, `namespace`, or constructor
  parameter properties — `as const` + `(typeof X)[number]` instead
  (`cli/src/errors.ts` is the pattern). `npm run typecheck`
  (`erasableSyntaxOnly`) catches violations.
- Import `.ts` extensions explicitly. This is an npm workspace, so the
  root-level `test/` directory resolves `yaml`, `ajv` + `ajv-formats`, and
  `node:test` from the root `node_modules`.
- **A command never writes to stdout directly** — that's what keeps `--json`
  a single JSON value. A command is declared in `commands/registry.ts` and
  returns a payload plus a human formatter; `main.ts` picks the renderer.
- **One definition, one schema, checked both ways**: `cli/src/model/<x>.ts`
  (or `errors.ts`, `config.ts`) is bound to `cli/schema/<x>.schema.json` by
  `test/contracts.test.ts`, and `test/app-models.test.ts` binds the Swift
  structs to the same schemas.
- **Side effects reach a command only through `Context`** (`cli/src/context.ts`):
  config, `Docker`, the catalogue loader, a host-port probe, `SsdDevice`
  (`lsof` + `diskutil`), a confirm prompt, `Git`, host UID/GID, the clock,
  `wait` — never `process.env`, a raw spawn, a socket, or a hard-coded root
  path reached for directly. That discipline is what lets a mutating command
  run against a temp directory and stubs in a test (`test/helpers.ts`).
- `BARDOLIER_CONFIG` relocates the config file — how the done-checks stay
  hermetic (`cli-spec.md` §8).

**A check is named for what it covers and stands alone.** Each builds its own
temp root and config (`test/lib.sh`), assumes nothing another check left
behind, and can run by itself. `contract` is the one that runs `npm test` and
the typecheck; `images` builds base images and runs Gradle under emulation,
so it runs last and takes minutes rather than seconds.
`BARDOLIER_SKIP_DOCKER=1` and `IMAGES_QUICK=1` skip legs a change can't
affect; `VERBOSE=1` prints every passing line, not just failures.

## Code map

Behaviour lives in `docs/cli-spec.md`; this is only where to find it. A
constant named here is read by several files that must agree — change it in
one place.

| File | Owns | Spec |
| --- | --- | --- |
| `layout.ts` | the four folders — `work`/`data`/`local`/`home` — created by `new`, re-ensured by every `up` | §3 |
| `compose.ts` | rendering; `PASSTHROUGH_ENV` — Compose **list** form, bare `NAME`, never `${NAME:-}`, which would inject an empty credential | §9 |
| `model/archetype.ts` | `ARCHETYPE_APP_PORT` — fixed inside the container, allocated on the host | §9 |
| `workspace.ts` | every write; skips one whose bytes already match | §9 |
| `allocator.ts` | manifest scan + host probe; free means both | §5 |
| `rootindex.ts` | the offline-root cache: write-through at every manifest write, reconciled wherever a scan already happens; never a second registry | §5, §8 |
| `extraports.ts`, `deps.ts` | declared ports; declared apt packages and the content-addressed derived image | §5.1, §9 |
| `services.ts` | manifest ⋈ catalogue, so `status` and `service list` cannot disagree | §4.1 |
| `volumes.ts` | orphans, derived and never recorded; knows the shared cache by `bardolier.role: cache` | §6 |
| `device.ts` (`SsdDevice`) | `isActionableHolder`, `parseDissenter`; `commands/ssd.ts` drives down-all → holders → eject | §6 |
| `install.ts` | finding and linking `bardolier` onto the host's PATH — the CLI-side half of `BardolierExecutable.swift`'s search | §6 |
| `images.ts` | `IMAGE_PLATFORM` (`bardolier-and` is amd64), `IMAGE_CACHE` (shared gradle/uv caches), `CONTAINER_HOME` | §4.3, §9 |
| `transfer.ts` | staged copies: `.<name>.incoming`, renamed only once complete; space checked first | §6 |
| `handoff.ts` | the stop note; every part best-effort, none may fail the `down` | §12 |
| `cli/images/<image>/Dockerfile` | the three base images, built with `HOST_UID`/`HOST_GID`; Claude Code is the one unpinned component | §4.3, §6 |

## Definition of done

New work gets a scoped spec in `docs/development/phases/` and a terminal
check; it isn't done until that check passes. The check joins the done-check
for the function it belongs to — a new one only for a function that has
none — and stays. The spec names any decision that must be answered first
(see `INTENT.md`'s decision table), and the check covers every `INTENT.md`
invariant the work could break.

## Irreversible decisions

If reversing a choice would touch more than roughly 20 files — language,
name, licence, storage layout, an on-disk or wire format — it belongs in
`INTENT.md`'s decision table, decided explicitly, before the work that
depends on it. Open an issue or discussion for anything that shape rather
than folding it into a pull request.
