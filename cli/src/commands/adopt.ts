/**
 * `bardolier adopt <source-path> <name> --archetype <a> [--services a,b]
 * [--root <name>] [--move] [--dry-run]` — `cli-spec.md` §6 (Projects).
 *
 * The mechanical half of bringing an existing, non-bardolier project onto
 * bardolier (`docs/migration-guide.md` steps 3-4): create the project, and
 * get the repository into `work/<repo>/`, as one atomic step. Judgement —
 * which archetype, which services, when to `git clone` the source's origin
 * instead of moving its working tree — stays with whoever is running the
 * migration; this command does not guess at any of it, the same way `new`
 * does not guess a service list.
 *
 * Structured like `new`/`clone`: everything that can fail (name free, root
 * readable, archetype known, services resolvable, source readable, enough
 * space) is checked before anything is written, and the project is staged
 * off to one side and swapped into place only once complete (`transfer.ts`)
 * — an interrupted adopt leaves the target root exactly as it found it.
 *
 * Unlike `move`, the source is always copied into the STAGED
 * project rather than renamed in place — there is no single directory to
 * rename, since the source lands one level down, inside a project this call
 * is also creating. `--move` only changes what happens to the source
 * afterwards: removed once the copy is confirmed landed, never before.
 */

import { existsSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { basename, join, resolve as resolvePath } from 'node:path'
import type { Context } from '../context.ts'
import { BardolierError } from '../errors.ts'
import { allocateAppPort, allocatePorts } from '../allocator.ts'
import { ARCHETYPE_APP_PORT, ARCHETYPE_BASE_IMAGE } from '../model/archetype.ts'
import type { ProjectManifest } from '../model/project.ts'
import type { AdoptOutput } from '../model/adopt.ts'
import type { AttachedService } from '../model/service.ts'
import { describeService } from '../services.ts'
import { seededFiles } from '../scaffold.ts'
import { WORK_DIR, ensureProjectDirs } from '../layout.ts'
import { defaultRoot } from '../projects.ts'
import { composePath, manifestPath, regenerateCompose, writeManifest } from '../workspace.ts'
import { validate } from '../schema.ts'
import { copyInto, requireSpace, sourceBytes, stageProject } from '../transfer.ts'
import { formatBytes } from '../volumes.ts'
import { requireArchetype, requireFreeName, requireProjectName, requireRoot, requestedOfflineRoots } from './new.ts'
import { renderDegradedRoots } from '../rootindex.ts'
import { parseServiceList, resolveServices } from './service.ts'

const USAGE = 'adopt <source-path> <name> --archetype <a> [--services a,b] [--root <name>] [--move] [--dry-run]'

export type AdoptRequest = {
  readonly source: string | undefined
  readonly name: string | undefined
  readonly archetype: string | undefined
  readonly services: string | undefined
  /** `--root <name>`, defaulting to the first configured root — same as `new`. */
  readonly root?: string
  /** Delete the source once the copy lands. Default leaves it untouched. */
  readonly move: boolean
  /** Report the plan; write nothing. See `model/adopt.ts` for why no port is ever in it. */
  readonly dryRun: boolean
}

function requireSourceDir(source: string | undefined): string {
  if (!source) throw new BardolierError('INVALID_ARGUMENT', `Usage: bardolier ${USAGE}`)
  const resolved = resolvePath(source)
  if (!existsSync(resolved) || !statSync(resolved).isDirectory()) {
    throw new BardolierError('INVALID_ARGUMENT', `\`${source}\` is not a directory.`)
  }
  return resolved
}

export async function runAdopt(ctx: Context, request: AdoptRequest): Promise<AdoptOutput> {
  const name = requireProjectName(request.name, USAGE)
  const archetype = requireArchetype(request.archetype)
  const target = requireRoot(ctx, request.root, defaultRoot(ctx.config))
  const sourceDir = requireSourceDir(request.source)
  const repoName = basename(sourceDir)
  const mode: 'copy' | 'move' = request.move ? 'move' : 'copy'

  const dir = join(target.path, name)
  requireFreeName(ctx, name, dir)

  const requested = request.services === undefined ? [] : parseServiceList(request.services)
  const catalogue = requested.length > 0 ? ctx.catalogue().catalogue : null
  const definitions = catalogue ? resolveServices(catalogue, requested) : []

  // A read-only stat walk — real even under --dry-run, unlike a port (see model/adopt.ts).
  const bytes = sourceBytes([{ from: sourceDir, to: join(WORK_DIR, repoName) }])
  requireSpace(target.path, bytes)

  const sourceOutput = { path: sourceDir, dir: join(dir, WORK_DIR, repoName), basename: repoName }

  if (request.dryRun) {
    return {
      project: { name, archetype, base_image: ARCHETYPE_BASE_IMAGE[archetype], dir, root: target.name },
      requested_services: requested,
      services: [],
      source: sourceOutput,
      mode,
      bytes,
      dry_run: true,
    }
  }

  const manifest: ProjectManifest = {
    name,
    archetype,
    base_image: ARCHETYPE_BASE_IMAGE[archetype],
    created: ctx.now().toISOString(),
  }

  // Same order as `new`: the dev-server port first, so it is in the taken set
  // before any service is served from a band that could reach it (§9).
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

  // Validate before anything is written: a manifest that fails its own schema
  // would be invisible to `status` the moment it hit the disk.
  const { valid, errors } = validate('project', manifest)
  if (!valid) {
    throw new BardolierError('INTERNAL_ERROR', `Generated manifest does not match the project schema: ${errors.join('; ')}`)
  }

  const seeded: string[] = []
  const staged = stageProject(target.path, name, (staging) => {
    ensureProjectDirs(staging, definitions.map(({ key }) => key))
    copyInto(staging, [{ from: sourceDir, to: join(WORK_DIR, repoName) }])
    writeManifest(ctx, staging, manifest)

    for (const file of seededFiles(name, archetype)) {
      writeFileSync(join(staging, file.name), file.contents)
      seeded.push(file.name)
    }

    // Rendered from the new manifest, never copied: a generated file is never
    // authoritative (INTENT.md invariant 7).
    regenerateCompose(staging, manifest, catalogue)
    return bytes
  })

  // Only once the copy is confirmed landed — a failed stage above leaves the
  // source exactly as it was found.
  if (request.move) rmSync(sourceDir, { recursive: true, force: true })

  const degraded = requestedOfflineRoots(ctx)

  return {
    project: { name, archetype, base_image: manifest.base_image, dir: staged.dir, created: manifest.created, root: target.name },
    manifest_path: manifestPath(staged.dir),
    compose_path: composePath(staged.dir),
    seeded,
    requested_services: requested,
    services: attached,
    source: { ...sourceOutput, dir: join(staged.dir, WORK_DIR, repoName) },
    mode,
    bytes: staged.bytes,
    dry_run: false,
    ...(degraded.length > 0 ? { degraded_roots: degraded } : {}),
  }
}

export function renderAdopt(output: AdoptOutput): string[] {
  const { project } = output
  const verb = output.mode === 'move' ? 'moved' : 'copied'

  if (output.dry_run) {
    const lines = [
      `Would adopt ${output.source.path} → ${project.name} [${project.archetype}] at ${project.dir}`,
      `  source:   ${formatBytes(output.bytes)} would be ${verb} to work/${output.source.basename}/`,
    ]
    if (output.requested_services.length > 0) {
      lines.push(`  services: ${output.requested_services.join(', ')} (ports allocated once this runs for real)`)
    }
    lines.push('', `Nothing was written. Run without --dry-run, then \`bardolier status ${project.name} --json\` for the real ports.`)
    return lines
  }

  const lines = [
    `Adopted ${output.source.path} → ${project.name} [${project.archetype}] at ${project.dir}`,
    `  source:   ${formatBytes(output.bytes)} ${verb} to work/${output.source.basename}/`,
    `  manifest: ${output.manifest_path}`,
    `  compose:  ${output.compose_path}  (generated — do not edit)`,
  ]
  if (output.seeded && output.seeded.length > 0) lines.push(`  seeded:   ${output.seeded.join(', ')}`)
  if (output.services.length > 0) {
    lines.push('  services:')
    for (const service of output.services) {
      lines.push(`    ${service.display} (${service.key})  host :${service.host_port} → :${service.container_port}   ${service.connection_hint}`)
    }
  }
  lines.push(...renderDegradedRoots(output.degraded_roots ?? []))
  lines.push('')
  lines.push(`Next: bardolier up ${project.name}`)
  return lines
}
