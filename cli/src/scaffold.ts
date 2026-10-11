/**
 * Seeded files — `cli-spec.md` §10.
 *
 * `new` writes these once and never touches them again: they are the user's
 * files from that moment on, unlike the compose file, which is regenerated.
 * The one exception is `env.md`, which `bardolier env --write` refreshes on
 * request.
 *
 * They live in `work/<name>/` so other repositories can be cloned into `work/`
 * beside the project without clashing. Nothing here names bardolier except one
 * footer line: the environment must be reproducible without the tool.
 */

import type { Archetype } from './model/archetype.ts'
import { ARCHETYPE_APP_PORT } from './model/archetype.ts'
import type { CatalogueService } from './model/catalogue.ts'
import type { ProjectManifest } from './model/project.ts'
import { interpolate } from './compose.ts'
import { BardolierError } from './errors.ts'
import { imageToolchain } from './images.ts'
import { CONTAINER_DATA, CONTAINER_LOCAL, CONTAINER_WORK, WORK_DIR } from './layout.ts'

export const REPOSITORY_URL = 'https://github.com/mark2802/bardolier'

/** Whether `text` is an `env.md` bardolier rendered, as opposed to a repo's own file of that name. */
export function isRenderedEnvMd(text: string): boolean {
  return text.startsWith('# Environment — ') && text.includes(`Created with Bardolier — ${REPOSITORY_URL}`)
}

/** Docs live under the project folder: `work/<name>/docs/`. */
export const DOCS_DIR = 'docs'
export const ENV_DOC = 'env.md'

/** The archetype-specific boundary note (§10). */
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

const BASE_OS: Readonly<Record<string, string>> = {
  'bardolier-web': 'Debian 12 (bookworm-slim) on the official `node` image',
  'bardolier-ios': 'Ubuntu 24.04 (noble) on the official `swift` image',
  'bardolier-and': 'Ubuntu 24.04 (noble) on the official `eclipse-temurin` JDK image (linux/amd64)',
}

const TOOL_LABEL: Readonly<Record<string, string>> = {
  NODE_VERSION: 'Node.js',
  UV_VERSION: 'uv (manages Python installs; no system Python)',
  SWIFT_VERSION: 'Swift',
  SWIFTLINT_VERSION: 'SwiftLint',
  JAVA_VERSION: 'JDK',
  GRADLE_VERSION: 'Gradle',
  ANDROID_PLATFORM: 'Android platform',
  ANDROID_BUILD_TOOLS: 'Android build-tools',
}

export function claudeMd(name: string): string {
  return `# ${name}

Read these only when a task needs them:

- \`docs/product.md\` — what this project is meant to build: purpose, users, scope and
  constraints. Read before planning features or making product decisions.
- \`docs/dev-principles.md\` — how code is written and changed here. Read before
  writing or changing code.
- \`docs/env.md\` — the development environment: toolchain, services and how to reach
  them, filesystem, and what cannot run here. Read before building, running or
  testing, before connecting to a service, or when something environmental fails.
`
}

export function productMd(name: string): string {
  return `# ${name} — product

_Placeholder. Describe what this project is intended to build._

## Purpose

## Users

## Scope

### In

### Out

## Constraints
`
}

export function devPrinciplesMd(): string {
  return `# Development principles

## Working rules

- Treat project documentation as authoritative; if docs and code disagree, say so.
- If instructions conflict, ask before proceeding.
- For non-trivial changes, propose a plan before writing code.
- Keep changes scoped to the task; no unrelated edits or reformatting.
- Don't add a dependency without saying why.
- Never commit secrets; configuration comes from the environment.
- Typecheck and lint after code changes, where the language has them.

## APIs

- API-first: for HTTP APIs, write the OpenAPI spec — fully typed, with examples —
  before the implementation.
- Schema changes go through versioned migrations.

## Testing

- Run the narrowest test that covers the change; run the full suite before calling
  work done.
- Mock only interfaces you own; wrap third-party APIs in an adapter.
- Don't overfit to tests.
- No real clock, randomness or environment reads in domain logic — inject them.

## Design

- Design for testability first.
- Separate domain logic from infrastructure (I/O, persistence, notifications).
- Small modules, single responsibility. Composition over inheritance.
- Depend on abstractions; inject dependencies explicitly. No global state or hidden
  dependencies.
- Interfaces minimal and intention-revealing; names reflect behaviour, not
  implementation.
- Fail fast with clear errors. Optimise for readability.
- Delete unused code aggressively; refactor continuously.
`
}

/** A service the project has attached, resolved against the catalogue. */
export type EnvService = { readonly key: string; readonly definition: CatalogueService }

/**
 * `docs/env.md`: deterministic for a manifest + catalogue + bundled image, and
 * free of host ports (machine-specific; a clone allocates its own).
 */
export function envMd(manifest: ProjectManifest, services: readonly EnvService[], folder = manifest.work_folder): string {
  const { name, archetype } = manifest
  const toolchain = Object.entries(imageToolchain(manifest.base_image)).map(
    ([arg, version]) => `- ${TOOL_LABEL[arg] ?? arg}: ${version}`,
  )
  const extras = manifest.extra_packages ?? []
  const appPort = ARCHETYPE_APP_PORT[archetype]
  const extraPorts = Object.entries(manifest.extra_ports ?? {}).sort(([a], [b]) => a.localeCompare(b))

  const out: string[] = [`# Environment — ${name}`, '']
  out.push(
    'Development runs in a Linux container as a non-root user with the host user’s uid,',
    `on ${BASE_OS[manifest.base_image] ?? manifest.base_image}. The agent (Claude Code), git, ripgrep, jq and curl are installed.`,
    '',
    '## Toolchain',
    '',
    ...toolchain,
    ...(extras.length > 0 ? [`- Extra apt packages: ${extras.join(', ')}`] : []),
    '',
    '## Filesystem',
    '',
    `- \`${CONTAINER_WORK}\` — repositories. ${folder === undefined ? 'The project is rooted here' : `This project is \`${CONTAINER_WORK}/${folder}\``}; other repos can sit beside it.`,
    `- \`${CONTAINER_DATA}\` — service data, **read-only**. Look, don't write: a live database written from a second container corrupts.`,
    `- \`${CONTAINER_LOCAL}\` — scratch space that is neither repository nor service data.`,
    '- `$HOME` persists across restarts; the container itself does not.',
    '',
  )

  out.push(
    '## Services',
    '',
    'Backing services run as sibling containers on one Docker network. **Connect by name**,',
    'exactly as production would. Any port a service publishes on the host is a debugging',
    'tap for GUI tools only — never wire application code to `localhost:<port>`.',
    '',
  )
  if (services.length > 0) {
    out.push('| Service | Image | Address in the network | Environment |', '| --- | --- | --- | --- |')
    for (const { key, definition } of [...services].sort((a, b) => a.key.localeCompare(b.key))) {
      const env = Object.entries(definition.env ?? {})
        .map(([k, v]) => `\`${k}=${interpolate(v, name)}\``)
        .join(' ')
      out.push(`| ${definition.display} | \`${definition.image}\` | \`${key}:${definition.container_port}\` | ${env} |`)
    }
  } else {
    out.push('None attached.')
  }
  out.push('')

  if (appPort !== undefined || extraPorts.length > 0) {
    out.push('## Ports published to the host', '')
    if (appPort !== undefined) {
      out.push(
        `- Dev server: **${appPort}** inside the container; \`$PORT\` is set to it. **Bind to \`0.0.0.0\`, not \`localhost\`** — a server on the container’s own loopback is unreachable from the host and looks like a broken port mapping. Frameworks such as Next.js are project dependencies, not part of the image. A second process in the container (e.g. a Python API) is reached through the dev server’s proxy, not a second published port.`,
      )
    }
    for (const [portName, port] of extraPorts) out.push(`- \`${portName}\`: ${port.container_port} inside the container.`)
    out.push('')
  }

  out.push('## Boundary', '', BOUNDARY[archetype], '', '---', '', `Created with Bardolier — ${REPOSITORY_URL}`, '')
  return out.join('\n')
}

export type SeededFile = {
  /** Relative to the project directory. */
  readonly name: string
  readonly contents: string
}

/** The §10 seed set — four files under `work/<work_folder>/`. */
export function seededFiles(manifest: ProjectManifest, services: readonly EnvService[]): SeededFile[] {
  const folder = manifest.work_folder
  if (folder === undefined) throw new BardolierError('INTERNAL_ERROR', `Seeding \`${manifest.name}\` without a work_folder.`)
  const base = `${WORK_DIR}/${folder}`
  return [
    { name: `${base}/CLAUDE.md`, contents: claudeMd(manifest.name) },
    { name: `${base}/${DOCS_DIR}/${ENV_DOC}`, contents: envMd(manifest, services, folder) },
    { name: `${base}/${DOCS_DIR}/product.md`, contents: productMd(manifest.name) },
    { name: `${base}/${DOCS_DIR}/dev-principles.md`, contents: devPrinciplesMd() },
  ]
}
