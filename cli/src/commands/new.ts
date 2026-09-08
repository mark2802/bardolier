/**
 * `bardolier new <name> --archetype <a>` — `cli-spec.md` §6 (Projects), §10.
 *
 * Creates, in this order: the directory, the manifest, the seeded files, the
 * compose file. The manifest goes down before anything derived from it, so a
 * crash mid-way leaves a directory that `status` can still read rather than an
 * unattributable pile of files.
 *
 * The target root must already be readable. Creating it ourselves would put
 * the project on the internal disk the moment the disk was unplugged — exactly
 * the failure the split-storage design exists to prevent. `--root <name>`
 * (phase 18) picks which configured root to use, defaulting to the first;
 * an unreadable target is ROOT_UNREADABLE, not SSD_NOT_MOUNTED — it names the
 * one root this call cares about, not "nothing is mounted anywhere".
 */

import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { RootConfig } from '../config.ts'
import type { Context } from '../context.ts'
import { BardolierError } from '../errors.ts'
import { ARCHETYPES, ARCHETYPE_APP_PORT, ARCHETYPE_BASE_IMAGE, isArchetype } from '../model/archetype.ts'
import type { Archetype } from '../model/archetype.ts'
import type { ProjectManifest } from '../model/project.ts'
import type { NewOutput } from '../model/lifecycle.ts'
import type { AttachedService } from '../model/service.ts'
import { allocateAppPort, allocatePorts } from '../allocator.ts'
import { describeService } from '../services.ts'
import { parseServiceList, resolveServices } from './service.ts'
import { seededFiles } from '../scaffold.ts'
import { ensureProjectDirs, PROJECT_DIRS } from '../layout.ts'
import { defaultRoot, discoverProjects, findProject, probeRoot, unreadableRoots } from '../projects.ts'
import { offlineRoots, readRootIndex, renderDegradedRoots } from '../rootindex.ts'
import { composePath, manifestPath, regenerateCompose, writeManifest } from '../workspace.ts'
import { validate } from '../schema.ts'

/** Mirrors `project.schema.json`'s `name` pattern; it is also a directory name. */
const NAME_PATTERN = /^[a-z0-9][a-z0-9._-]*$/

export type NewRequest = {
  readonly name: string | undefined
  readonly archetype: string | undefined
  /** Raw `--services a,b`; ports are assigned now, at creation (§5, §6). */
  readonly services: string | undefined
  /** `--root <name>`, defaulting to the first configured root (phase 18). */
  readonly root?: string
}

/** Shared with `clone`, whose new name is validated by exactly this rule (phase 20). */
export function requireProjectName(name: string | undefined, usage: string): string {
  if (!name) throw new BardolierError('INVALID_ARGUMENT', `Usage: bardolier ${usage}`)
  if (!NAME_PATTERN.test(name)) {
    throw new BardolierError(
      'INVALID_ARGUMENT',
      `\`${name}\` is not a usable project name: use lower-case letters, digits, dot, dash or underscore, starting with a letter or digit.`,
    )
  }
  return name
}

function requireArchetype(value: string | undefined): Archetype {
  if (!value) {
    throw new BardolierError('INVALID_ARGUMENT', `--archetype is required (one of: ${ARCHETYPES.join(', ')}).`)
  }
  if (!isArchetype(value)) {
    throw new BardolierError('INVALID_ARGUMENT', `Unknown archetype \`${value}\`. Expected one of: ${ARCHETYPES.join(', ')}.`)
  }
  return value
}

/**
 * Which readable root to create under. `fallback` is `roots[0]` for `new` and
 * the SOURCE's root for `clone` — a clone is another one of these, and that is
 * where its kind lives (phase 20). `purpose` only changes the ROOT_UNREADABLE
 * wording — `move` (phase 21) isn't creating anything.
 */
export function requireRoot(
  ctx: Context,
  name: string | undefined,
  fallback: RootConfig,
  purpose = 'refusing to create a project on the internal disk',
): RootConfig {
  const root = name === undefined ? fallback : ctx.config.roots.find((r) => r.name === name)
  if (!root) {
    throw new BardolierError(
      'INVALID_ARGUMENT',
      `Unknown root \`${name}\`. Configured roots: ${ctx.config.roots.map((r) => r.name).join(', ')}.`,
    )
  }
  if (!probeRoot(root).mounted) {
    throw new BardolierError(
      'ROOT_UNREADABLE',
      `Root \`${root.name}\` (${root.path}) is not readable; ${purpose}.`,
      { roots: [root.name] },
    )
  }
  return root
}

/**
 * Refuse a name anything already answers to. PROJECT_EXISTS means "in any
 * root": two projects sharing a name would share a container name and a home
 * volume (§9), which is destructive.
 *
 * Unlike a port (`allocator.ts`), this cannot be allowed to guess: a name
 * collision is invariant 3, not invariant 4. So an unreadable root without an
 * index is still ROOT_UNREADABLE here — the one case phase 27 leaves strict —
 * and one with an index is checked against it exactly like a readable root.
 */
export function requireFreeName(ctx: Context, name: string, dir: string): void {
  const discovery = discoverProjects(ctx.config)
  const elsewhere = findProject(discovery, name) ?? null
  if (elsewhere || existsSync(dir)) {
    throw new BardolierError('PROJECT_EXISTS', `\`${name}\` already exists at ${elsewhere?.dir ?? dir}.`)
  }

  for (const root of unreadableRoots(discovery)) {
    const index = readRootIndex(ctx.loaded.path, root)
    if (!index) {
      throw new BardolierError(
        'ROOT_UNREADABLE',
        `Cannot confirm \`${name}\` is unique while \`${root.name}\` (${root.path}) is unreadable and has never been indexed. Plug it in once — after that, this works with it offline too.`,
        { roots: [root.name] },
      )
    }
    const there = index.projects.find((p) => p.name === name)
    if (there) {
      throw new BardolierError(
        'PROJECT_EXISTS',
        `\`${name}\` already exists on \`${root.name}\` (offline; last seen ${index.scanned}).`,
        { root: root.name },
      )
    }
  }
}

/** Every root this call could not read, for a `degraded_roots` receipt on the output. */
export function requestedOfflineRoots(ctx: Context): ReturnType<typeof offlineRoots> {
  return offlineRoots(ctx, discoverProjects(ctx.config))
}

export async function runNew(ctx: Context, request: NewRequest): Promise<NewOutput> {
  const name = requireProjectName(request.name, 'new <name> --archetype <a>')
  const archetype = requireArchetype(request.archetype)
  const target = requireRoot(ctx, request.root, defaultRoot(ctx.config))

  const dir = join(target.path, name)
  requireFreeName(ctx, name, dir)

  // Everything that can fail happens before the directory exists: an unknown
  // service key or an exhausted port band must leave nothing behind (§5, §6).
  const requested = request.services === undefined ? [] : parseServiceList(request.services)
  const catalogue = requested.length > 0 ? ctx.catalogue().catalogue : null
  const definitions = catalogue ? resolveServices(catalogue, requested) : []

  const manifest: ProjectManifest = {
    name,
    archetype,
    base_image: ARCHETYPE_BASE_IMAGE[archetype],
    created: ctx.now().toISOString(),
  }

  // The dev-server port first, so it is in the taken set before any service is
  // served from a band that could reach it (§9). Archetypes with no dev server
  // get nothing and the field stays absent.
  const appPortBase = ARCHETYPE_APP_PORT[archetype]
  if (appPortBase !== undefined) {
    manifest.app_port = await allocateAppPort(ctx, name, appPortBase)
  }

  const attached: AttachedService[] = []
  if (definitions.length > 0) {
    const reserved = manifest.app_port === undefined ? [] : [manifest.app_port]
    const allocated = await allocatePorts(ctx, name, definitions, reserved)
    const services: Record<string, { host_port: number }> = {}
    for (const { key, definition } of definitions) {
      const hostPort = allocated.get(key)
      if (hostPort === undefined) throw new BardolierError('INTERNAL_ERROR', `The allocator returned no port for \`${key}\`.`)
      services[key] = { host_port: hostPort }
      attached.push(describeService(name, key, definition, hostPort, dir))
    }
    manifest.services = services
  }

  // Validate before writing: a manifest that fails its own schema would be
  // invisible to `status` the moment it hit the disk.
  const { valid, errors } = validate('project', manifest)
  if (!valid) {
    throw new BardolierError('INTERNAL_ERROR', `Generated manifest does not match the project schema: ${errors.join('; ')}`)
  }

  mkdirSync(dir, { recursive: false })
  // Before anything is bind-mounted from them (§4.2): a source Docker has to
  // create itself comes back root-owned, or — on Docker Desktop — inside the
  // VM rather than on the disk the project is on.
  ensureProjectDirs(dir, definitions.map(({ key }) => key))
  writeManifest(ctx, dir, manifest)

  const seeded: string[] = []
  for (const file of seededFiles(name, archetype)) {
    writeFileSync(join(dir, file.name), file.contents)
    seeded.push(file.name)
  }

  // Without `--services` the catalogue is never consulted, so `new` still works
  // with a broken one — `doctor` is the right place to complain about that.
  regenerateCompose(dir, manifest, catalogue)

  const degraded = requestedOfflineRoots(ctx)

  return {
    project: { name, archetype, base_image: manifest.base_image, dir, created: manifest.created, root: target.name },
    manifest_path: manifestPath(dir),
    compose_path: composePath(dir),
    seeded,
    services: attached,
    ...(degraded.length > 0 ? { degraded_roots: degraded } : {}),
  }
}

export function renderNew(output: NewOutput): string[] {
  const { project } = output
  const lines = [
    `Created ${project.name} [${project.archetype}] at ${project.dir}`,
    `  manifest: ${output.manifest_path}`,
    `  compose:  ${output.compose_path}  (generated — do not edit)`,
    `  layout:   ${PROJECT_DIRS.map((name) => `${name}/`).join('  ')}`,
    `  seeded:   ${output.seeded.join(', ')}`,
  ]
  if (output.services.length > 0) {
    lines.push('  services:')
    for (const service of output.services) {
      lines.push(`    ${service.display} (${service.key})  host :${service.host_port} → :${service.container_port}   ${service.connection_hint}`)
    }
  }
  lines.push(...renderDegradedRoots(output.degraded_roots ?? []))
  lines.push('')
  if (output.services.length === 0) {
    lines.push(`Next: bardolier service add ${project.name} postgres   # attach a service`)
    lines.push(`      bardolier up ${project.name}`)
  } else {
    lines.push(`Next: bardolier up ${project.name}`)
  }
  return lines
}
