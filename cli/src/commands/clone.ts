/**
 * `bardolier clone <source> <name> [--root <name>] [--with-content]` —
 * `cli-spec.md` §6 (Projects).
 *
 * A clone is the source's manifest with a new name, fresh ports and a fresh
 * `created`. Reproducing that by hand is `new` plus a `service add` per service,
 * a `port add` per extra port and a `deps add` — every step a chance to end up
 * with a project that is nearly, but not exactly, the one it was meant to
 * resemble.
 *
 * WHAT TRAVELS: under `--with-content`, all four folders of §3 — `work/`,
 * `data/`, `local/` and `home/`. A clone means an identical copy; this is a
 * personal tool and nothing here leaves the owner's own disks.
 *
 * `data/` is why the source must be STOPPED: service state copied out from
 * under a running Postgres is torn. `home/` carries the container's $HOME —
 * the `claude login`, ssh keys, dotfiles and shell history — and with it Claude
 * Code's session transcripts, which are filed by working directory. Every dev
 * container works in `/work` (§9), so the clone inherits the source's
 * transcripts under the same key: `claude --continue` in a fresh clone resumes
 * the SOURCE's last conversation until a new one is started. Accepted
 * deliberately — the homes stay separate afterwards, so nothing diverges.
 *
 * Nothing about the source is read but `project.yml` for a shape clone, and
 * nothing about it is written in either case.
 */

import { existsSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Context } from '../context.ts'
import { BardolierError } from '../errors.ts'
import { allocateAppPort, allocateExtraPort, allocatePorts } from '../allocator.ts'
import { ARCHETYPE_APP_PORT } from '../model/archetype.ts'
import type { ProjectManifest } from '../model/project.ts'
import type { CloneOutput } from '../model/lifecycle.ts'
import type { AttachedService } from '../model/service.ts'
import { attachedKeys } from '../compose.ts'
import { extraPortNames } from '../extraports.ts'
import { describeService } from '../services.ts'
import { seededFiles } from '../scaffold.ts'
import { DATA_DIR, HOME_DIR, LOCAL_DIR, WORK_DIR, ensureProjectDirs } from '../layout.ts'
import { findRoot } from '../projects.ts'
import { composePath, manifestPath, regenerateCompose, requireProject, writeManifest } from '../workspace.ts'
import { validate } from '../schema.ts'
import { copyInto, requireSpace, sourceBytes, stageProject, type CopySource } from '../transfer.ts'
import { formatBytes } from '../volumes.ts'
import { requireFreeName, requireProjectName, requireRoot, requestedOfflineRoots } from './new.ts'
import { renderDegradedRoots } from '../rootindex.ts'
import { requireStopped, resolveServices } from './service.ts'

export type CloneRequest = {
  readonly source: string | undefined
  readonly name: string | undefined
  /** `--root <name>`, defaulting to the SOURCE's root, not `roots[0]`. */
  readonly root?: string
  /** Copy all four folders of §3 byte-for-byte. Requires the source stopped. */
  readonly withContent: boolean
}

/** The four folders of §3. All of them: a clone is an identical copy. */
const CONTENT_DIRS = [WORK_DIR, DATA_DIR, LOCAL_DIR, HOME_DIR] as const

function contentSources(sourceDir: string): CopySource[] {
  return CONTENT_DIRS.flatMap((name) => {
    const from = join(sourceDir, name)
    // A project that never ran may be missing one; `ensureProjectDirs` has
    // already made the empty equivalent in the staging directory.
    if (!existsSync(from) || !statSync(from).isDirectory()) return []
    return [{ from, to: name }]
  })
}

export async function runClone(ctx: Context, request: CloneRequest): Promise<CloneOutput> {
  const source = requireProject(ctx, request.source)
  const name = requireProjectName(request.name, 'clone <source> <name> [--root <name>] [--with-content]')

  const sourceRoot = findRoot(ctx.config, source.root)
  if (!sourceRoot) throw new BardolierError('INTERNAL_ERROR', `\`${source.name}\` was found under an unconfigured root.`)
  const target = requireRoot(ctx, request.root, sourceRoot)

  const dir = join(target.path, name)
  requireFreeName(ctx, name, dir)

  // Only content can be torn; a shape clone reads nothing but the manifest.
  if (request.withContent) await requireStopped(ctx, source, 'copying its content')

  const { manifest: from } = source
  const keys = attachedKeys(from)
  const catalogue = keys.length > 0 ? ctx.catalogue().catalogue : null
  const definitions = catalogue ? resolveServices(catalogue, keys) : []

  const manifest: ProjectManifest = {
    name,
    archetype: from.archetype,
    base_image: from.base_image,
    created: ctx.now().toISOString(),
  }
  if (from.extra_packages && from.extra_packages.length > 0) manifest.extra_packages = [...from.extra_packages]

  // NO HOST PORT IS COPIED. Each is allocated fresh, in the order `new` uses —
  // the dev server first, so it is in the taken set before any service is
  // served from a band that could reach it (§9). The allocator already scans
  // the source's manifest, so it cannot hand back a port the source holds (§5);
  // `reserved` covers what this same call has promised but not yet written.
  const reserved: number[] = []
  const appPortBase = ARCHETYPE_APP_PORT[from.archetype]
  if (appPortBase !== undefined) {
    manifest.app_port = await allocateAppPort(ctx, name, appPortBase)
    reserved.push(manifest.app_port)
  }

  const attached: AttachedService[] = []
  if (definitions.length > 0) {
    const allocated = await allocatePorts(ctx, name, definitions, reserved)
    const services: Record<string, { host_port: number }> = {}
    for (const { key, definition } of definitions) {
      const hostPort = allocated.get(key)
      if (hostPort === undefined) throw new BardolierError('INTERNAL_ERROR', `The allocator returned no port for \`${key}\`.`)
      services[key] = { host_port: hostPort }
      reserved.push(hostPort)
      attached.push(describeService(name, key, definition, hostPort, dir))
    }
    manifest.services = services
  }

  const extraNames = extraPortNames(from)
  if (extraNames.length > 0) {
    const extraPorts: Record<string, { container_port: number; host_port: number }> = {}
    for (const portName of extraNames) {
      const declared = from.extra_ports?.[portName]
      if (!declared) continue
      const hostPort = await allocateExtraPort(ctx, name, portName, declared.container_port, reserved)
      reserved.push(hostPort)
      extraPorts[portName] = { container_port: declared.container_port, host_port: hostPort }
    }
    manifest.extra_ports = extraPorts
  }

  // Validate before anything is written: a manifest that fails its own schema
  // would be invisible to `status` the moment it hit the disk.
  const { valid, errors } = validate('project', manifest)
  if (!valid) {
    throw new BardolierError('INTERNAL_ERROR', `Generated manifest does not match the project schema: ${errors.join('; ')}`)
  }

  const sources = request.withContent ? contentSources(source.dir) : []
  const bytes = sourceBytes(sources)
  requireSpace(target.path, bytes)

  const seeded: string[] = []
  const staged = stageProject(target.path, name, (staging) => {
    ensureProjectDirs(staging, keys)
    copyInto(staging, sources)
    writeManifest(ctx, staging, manifest)

    // Re-seeded unless the copy brought one: a seed you would overwrite is the
    // user's file by then (§10).
    for (const file of seededFiles(name, manifest.archetype)) {
      if (existsSync(join(staging, file.name))) continue
      writeFileSync(join(staging, file.name), file.contents)
      seeded.push(file.name)
    }

    // Rendered from the new manifest, never copied: a generated file is never
    // authoritative (INTENT.md invariant 7).
    regenerateCompose(staging, manifest, catalogue)
    return bytes
  })

  const degraded = requestedOfflineRoots(ctx)

  return {
    project: {
      name,
      archetype: manifest.archetype,
      base_image: manifest.base_image,
      dir: staged.dir,
      created: manifest.created,
      root: target.name,
    },
    manifest_path: manifestPath(staged.dir),
    compose_path: composePath(staged.dir),
    seeded,
    services: attached,
    source: source.name,
    with_content: request.withContent,
    bytes_copied: staged.bytes,
    ...(degraded.length > 0 ? { degraded_roots: degraded } : {}),
  }
}

export function renderClone(output: CloneOutput): string[] {
  const { project } = output
  const lines = [
    `Cloned ${output.source} → ${project.name} [${project.archetype}] at ${project.dir}`,
    output.with_content
      ? `  content:  ${formatBytes(output.bytes_copied)} copied from work/ data/ local/ home/`
      : `  content:  shape only — pass --with-content to copy work/ data/ local/ home/`,
    `  manifest: ${output.manifest_path}`,
    `  compose:  ${output.compose_path}  (generated — do not edit)`,
  ]
  if (output.seeded.length > 0) lines.push(`  seeded:   ${output.seeded.join(', ')}`)
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
