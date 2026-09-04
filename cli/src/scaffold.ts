/**
 * Seeded files — `cli-spec.md` §10.
 *
 * `new` writes these once and never touches them again: they are the user's
 * files from that moment on, unlike the compose file, which is regenerated.
 * That asymmetry is deliberate — a seed you cannot edit is a nuisance, and a
 * derived file you can edit is a lie.
 *
 * `.dockerignore` serves the disk-frugality goal directly: the build context is
 * a directory on the SSD that will accumulate `node_modules` and build output,
 * and none of it belongs in an image layer.
 */

import type { Archetype } from './model/archetype.ts'
import { ARCHETYPE_APP_PORT } from './model/archetype.ts'
import { WORKDIR } from './compose.ts'

/** Ignored everywhere, whatever the archetype. */
// `.bandolier/` holds the handoff note (§12) — generated on every stop, so it is
// churn rather than history. Ignored by default; track it deliberately if you
// want the notes in the repo.
const COMMON_IGNORE = ['.bandolier/', '.DS_Store', '*.log', '.env', '.env.local']

const NODE_IGNORE = ['node_modules/', 'dist/', 'build/', '.next/', 'coverage/']
// A project's own Python backend (§4.3, bandolier-web now carries `uv`) keeps its
// venv under /work like any other project file — bind-mounted, per-project,
// never shipped in a build context or committed.
const PYTHON_IGNORE = ['.venv/', '__pycache__/', '*.pyc']
const SWIFT_IGNORE = ['.build/', '.swiftpm/', 'DerivedData/', '*.xcuserstate', 'xcuserdata/']
const ANDROID_IGNORE = ['.gradle/', 'build/', 'local.properties', '*.apk', '*.aab']

const ARCHETYPE_IGNORE: Readonly<Record<Archetype, readonly string[]>> = {
  web: [...NODE_IGNORE, ...PYTHON_IGNORE],
  library: [...NODE_IGNORE, ...PYTHON_IGNORE],
  ios: [...SWIFT_IGNORE, ...NODE_IGNORE],
  android: [...ANDROID_IGNORE, ...NODE_IGNORE],
}

function ignoreFile(intro: readonly string[], entries: readonly string[]): string {
  return `${[...intro, '', ...entries].join('\n')}\n`
}

export function gitignore(archetype: Archetype): string {
  return ignoreFile(
    [`# Seeded by bandolier for the \`${archetype}\` archetype (cli-spec.md §10).`, '# Yours to edit — bandolier never rewrites this file.'],
    [...ARCHETYPE_IGNORE[archetype], ...COMMON_IGNORE],
  )
}

export function dockerignore(archetype: Archetype): string {
  return ignoreFile(
    [
      `# Seeded by bandolier for the \`${archetype}\` archetype (cli-spec.md §10).`,
      '# Keeps the build context small: images live on the internal disk and are',
      '# shared, so nothing project-sized should ever be copied into one.',
    ],
    ['.git/', '.gitignore', 'docker-compose.yml', ...ARCHETYPE_IGNORE[archetype], ...COMMON_IGNORE],
  )
}

/** The archetype-specific boundary note §10 requires. */
const BOUNDARY: Readonly<Record<Archetype, string>> = {
  web: [
    'Everything builds and runs **in the container**. There is no host-side build',
    'step for this archetype — if a command fails, fix it here rather than',
    'reaching for the Mac.',
  ].join('\n'),
  library: [
    'Everything builds and tests **in the container**. There is no host-side build',
    'step for this archetype.',
  ].join('\n'),
  ios: [
    '**Never run `xcodebuild`, the iOS Simulator, or code signing.** Those are',
    'macOS-host-only and absent from this container. In here you may edit source,',
    'run `swiftlint`, and run logic tests. Building the app, running it on a',
    'simulator or device, and signing are the human’s job on the Mac.',
    '',
    'If a task appears to need a host-only step, stop and say so in your summary',
    'rather than trying to work around the boundary.',
  ].join('\n'),
  android: [
    'Gradle builds and unit tests **run in this container** — use them freely.',
    '**The emulator is host-side**: never try to launch an AVD, run instrumented',
    'tests, or drive `adb` against a device from in here. Ask the human to run',
    'anything that needs the emulator.',
  ].join('\n'),
}

/**
 * The dev-server note, for the archetypes that publish one (§9).
 *
 * The 0.0.0.0 sentence is the whole reason this section exists. A dev server
 * that defaults to `localhost` binds the CONTAINER's loopback, which nothing on
 * the Mac can reach — the port is published, the browser gets nothing, and the
 * obvious conclusion ("the port mapping is broken") is the wrong one.
 */
function devServerNote(archetype: Archetype): string {
  const port = ARCHETYPE_APP_PORT[archetype]
  if (port === undefined) return ''
  return `
## The dev server

This project publishes one port to the Mac: the dev server, on **${port}**
inside the container. \`$PORT\` is set to it, and the host port it is published
on may differ — run \`bandolier status\` on the host for the URL to open.

**Bind to \`0.0.0.0\`, not \`localhost\`.** A server bound to localhost listens on
the container's own loopback, which no browser on the Mac can reach; the port
mapping will look broken when it is not. Most frameworks take \`--host 0.0.0.0\`
or an equivalent setting.

This is the ONLY port this container publishes. Services are the other way
round — you reach them by name over the network, as below.

Running a second process in here too (e.g. a Python API on \`localhost\`)?
Don't publish a second port — have the dev server's own proxy config forward
to it, the same way a browser only ever talks to the one port above.
`
}

export function projectClaudeMd(name: string, archetype: Archetype): string {
  return `# CLAUDE.md — ${name}

Seeded by \`bandolier new\` for the \`${archetype}\` archetype. Edit freely; bandolier
will not rewrite this file.

## Environment boundary

You are running **inside this project's dev container**. The project directory
is mounted at \`${WORKDIR}\` and owned by the host user, so files you create are
editable on the Mac without a chown.

${BOUNDARY[archetype]}
${devServerNote(archetype)}
## Services

Backing services (Postgres, Redis, …) run as sibling containers on this
project's Docker network. **Connect to them by service name over that network**
— \`postgres:5432\`, \`redis:6379\` — exactly as production would. Each service
also publishes a port on the Mac, but that port is a **debugging tap** for host
GUI tools only. Never wire application code to \`localhost:<port>\`; it would
make dev diverge from prod and would break the moment the port changed.

Run \`bandolier status ${name}\` on the host to see what is attached and where.

## Managing this project

The lifecycle is driven from the **host**, not from in here:

    bandolier status ${name}
    bandolier service add ${name} postgres
    bandolier up ${name}
    bandolier down ${name}

Nothing in this container should invoke \`bandolier\`, \`docker\`, or touch the
compose file. \`docker-compose.yml\` is **generated** from \`project.yml\` and
is overwritten on every regeneration — never hand-edit it.
`
}

export type SeededFile = {
  readonly name: string
  readonly contents: string
}

/** The §10 seed set, in a fixed order so `new`'s output is deterministic. */
export function seededFiles(name: string, archetype: Archetype): SeededFile[] {
  return [
    { name: '.gitignore', contents: gitignore(archetype) },
    { name: '.dockerignore', contents: dockerignore(archetype) },
    { name: 'CLAUDE.md', contents: projectClaudeMd(name, archetype) },
  ]
}
