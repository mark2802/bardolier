/**
 * Seeded files — `cli-spec.md` §10.
 *
 * `new` writes these once and never touches them again: they are the user's
 * files from that moment on, unlike the compose file, which is regenerated.
 * That asymmetry is deliberate — a seed you cannot edit is a nuisance, and a
 * derived file you can edit is a lie.
 *
 * Since phase 19 there is exactly one seed, and it goes into `work/`. There is
 * no repo root to seed: bardolier's files live above `work/`, outside every
 * working tree, so there is nothing for a `.gitignore` to hide and nothing a
 * build context has ever been taken from (`deps.ts` builds from a generated
 * context under the config dir).
 */

import type { Archetype } from './model/archetype.ts'
import { ARCHETYPE_APP_PORT } from './model/archetype.ts'
import { CONTAINER_DATA, CONTAINER_LOCAL, CONTAINER_WORK, WORK_DIR } from './layout.ts'

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
on may differ — run \`bardolier status\` on the host for the URL to open.

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

Seeded by \`bardolier new\` for the \`${archetype}\` archetype. Edit freely; bardolier
will not rewrite this file.

## Where you are

You are running **inside this project's dev container**, working in
\`${CONTAINER_WORK}\` — the project's \`${WORK_DIR}/\` folder, bind-mounted and owned by the
host user, so files you create are editable on the Mac without a chown. Clone
or \`git init\` repositories here; this is the only part of the project a
repository ever contains.

Two more folders are mounted beside it:

- \`${CONTAINER_DATA}\` — the services' data directories, **read-only**. Look, don't write:
  a live database written to from a second container corrupts.
- \`${CONTAINER_LOCAL}\` — scratch space that is neither repository nor service data.

\`project.yml\` and \`docker-compose.yml\` are above all of these and deliberately
not visible from in here.

## Environment boundary

${BOUNDARY[archetype]}
${devServerNote(archetype)}
## Services

Backing services (Postgres, Redis, …) run as sibling containers on this
project's Docker network. **Connect to them by service name over that network**
— \`postgres:5432\`, \`redis:6379\` — exactly as production would. Each service
also publishes a port on the Mac, but that port is a **debugging tap** for host
GUI tools only. Never wire application code to \`localhost:<port>\`; it would
make dev diverge from prod and would break the moment the port changed.

Run \`bardolier status ${name}\` on the host to see what is attached and where.

## Managing this project

The lifecycle is driven from the **host**, not from in here:

    bardolier status ${name}
    bardolier service add ${name} postgres
    bardolier up ${name}
    bardolier down ${name}

Nothing in this container should invoke \`bardolier\` or \`docker\`.
\`docker-compose.yml\` is **generated** from \`project.yml\` and is overwritten on
every regeneration — never hand-edit it. Neither file is reachable from in here
anyway.
`
}

export type SeededFile = {
  readonly name: string
  readonly contents: string
}

/**
 * The §10 seed set — one file, in `work/`.
 *
 * `work/CLAUDE.md` rather than the project root: the agent's working directory
 * is `work/`, so that is where it looks, and a repository cloned in beside it
 * never contains the file.
 */
export function seededFiles(name: string, archetype: Archetype): SeededFile[] {
  return [{ name: `${WORK_DIR}/CLAUDE.md`, contents: projectClaudeMd(name, archetype) }]
}
