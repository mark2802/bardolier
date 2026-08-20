/**
 * `cproj service add | remove | list` — `cli-spec.md` §6 (Services), §5.
 *
 * Add and remove both REQUIRE THE PROJECT STOPPED and fail PROJECT_RUNNING
 * otherwise. That is a design choice, not a limitation: a hot-apply path would
 * mean reconciling a live compose project against a manifest that changed
 * underneath it, and every state machine downstream — `status`, the app's
 * activity rendering — would have to model the in-between. Stopping first keeps
 * "the manifest describes what is running" true at all times.
 *
 * Detaching KEEPS the data volume. It becomes a listed orphan, reclaimable
 * through `volumes rm` (Phase 4). Removing a service is a wiring change; losing
 * a database to it would be a data loss the user never asked for.
 *
 * `list` is Docker-free by design — manifest plus catalogue, no daemon — so it
 * answers while Docker is down. Live state comes from `status` (§7).
 */

import type { Context } from '../context.ts'
import { CprojError } from '../errors.ts'
import { attachedKeys, renderCompose, volumeName } from '../compose.ts'
import { allocatePorts, type PortRequest } from '../allocator.ts'
import { attachedServices, describeService } from '../services.ts'
import { validate } from '../schema.ts'
import type { ProjectManifest } from '../model/project.ts'
import type { ServiceCatalogue } from '../model/catalogue.ts'
import type { ServiceAddOutput, ServiceListOutput, ServiceRemoveOutput } from '../model/service.ts'
import { composePath, observeProject, regenerateCompose, requireProject, writeManifest } from '../workspace.ts'
import type { DiscoveredProject } from '../projects.ts'

export type ServiceRequest = {
  readonly project: string | undefined
  readonly service: string | undefined
}

function requireServiceKey(value: string | undefined, usage: string): string {
  if (!value) throw new CprojError('INVALID_ARGUMENT', `Usage: cproj ${usage}`)
  return value
}

/** The catalogue is consulted only when something references it (§4.1 chain can fail). */
function catalogueIfNeeded(ctx: Context, manifest: ProjectManifest): ServiceCatalogue | null {
  return attachedKeys(manifest).length > 0 ? ctx.catalogue().catalogue : null
}

/**
 * The stopped precondition. Anything of this project's up at all — dev
 * container or a single service — blocks the change; a partially running
 * project is exactly the state a mid-flight rewire would make permanent.
 */
async function requireStopped(ctx: Context, project: DiscoveredProject, action: string): Promise<void> {
  const observed = await observeProject(ctx, project.manifest)
  if (observed.state === 'stopped') return
  throw new CprojError(
    'PROJECT_RUNNING',
    `\`${project.name}\` is ${observed.state}; ${action} needs it stopped. Run \`cproj down ${project.name}\` first.`,
    { project: project.name, state: observed.state },
  )
}

/**
 * Write the manifest, then regenerate the compose file from it.
 *
 * Rendering happens once BEFORE the manifest hits the disk: a manifest that
 * cannot be rendered (an attachment the catalogue no longer defines) must fail
 * with the project untouched, rather than leaving `project.yml` describing
 * something `docker-compose.yml` does not.
 */
function persist(dir: string, manifest: ProjectManifest, catalogue: ServiceCatalogue | null) {
  renderCompose({ manifest, catalogue })

  const { valid, errors } = validate('project', manifest)
  if (!valid) {
    throw new CprojError('INTERNAL_ERROR', `Updated manifest does not match the project schema: ${errors.join('; ')}`)
  }

  writeManifest(dir, manifest)
  return regenerateCompose(dir, manifest, catalogue)
}

// ── add ──────────────────────────────────────────────────────────────────────

export async function runServiceAdd(ctx: Context, request: ServiceRequest): Promise<ServiceAddOutput> {
  const project = requireProject(ctx, request.project)
  const key = requireServiceKey(request.service, 'service add <project> <svc>')
  const { manifest, dir } = project

  const catalogue = ctx.catalogue().catalogue
  const definition = catalogue.services[key]
  if (!definition) {
    const known = Object.keys(catalogue.services).sort().join(', ')
    throw new CprojError(
      'SERVICE_UNKNOWN',
      `The service catalogue defines no \`${key}\`. Known services: ${known || 'none'}.`,
      { service: key },
    )
  }

  if (manifest.services?.[key]) {
    throw new CprojError(
      'SERVICE_ATTACHED',
      `\`${key}\` is already attached to \`${manifest.name}\` on host port ${manifest.services[key].host_port}.`,
      { project: manifest.name, service: key, host_port: manifest.services[key].host_port },
    )
  }

  await requireStopped(ctx, project, 'attaching a service')

  const allocated = await allocatePorts(ctx, manifest.name, [{ key, definition }])
  const hostPort = allocated.get(key)
  if (hostPort === undefined) throw new CprojError('INTERNAL_ERROR', `The allocator returned no port for \`${key}\`.`)

  const next: ProjectManifest = {
    ...manifest,
    services: { ...(manifest.services ?? {}), [key]: { host_port: hostPort } },
  }
  const regenerated = persist(dir, next, catalogue)

  return {
    project: manifest.name,
    added: describeService(manifest.name, key, definition, hostPort),
    services: attachedServices(next, catalogue),
    compose_path: composePath(dir),
    compose_regenerated: regenerated.changed,
  }
}

export function renderServiceAdd(output: ServiceAddOutput): string[] {
  const { added } = output
  return [
    `Attached ${added.display} (${added.key}) to ${output.project}.`,
    `  host port: ${added.host_port} → :${added.container_port}   ${added.connection_hint}`,
    `  volume:    ${added.volume}`,
    `  compose:   ${output.compose_path}${output.compose_regenerated ? ' (regenerated)' : ' (unchanged)'}`,
    '',
    `The host port is a debugging tap. Inside the project, connect to \`${added.key}:${added.container_port}\`.`,
    `Next: cproj up ${output.project}`,
  ]
}

// ── remove ───────────────────────────────────────────────────────────────────

export async function runServiceRemove(ctx: Context, request: ServiceRequest): Promise<ServiceRemoveOutput> {
  const project = requireProject(ctx, request.project)
  const key = requireServiceKey(request.service, 'service remove <project> <svc>')
  const { manifest, dir } = project

  const attachment = manifest.services?.[key]
  if (!attachment) {
    const attached = attachedKeys(manifest).join(', ')
    throw new CprojError(
      'SERVICE_NOT_ATTACHED',
      `\`${key}\` is not attached to \`${manifest.name}\`.${attached ? ` Attached: ${attached}.` : ''}`,
      { project: manifest.name, service: key },
    )
  }

  await requireStopped(ctx, project, 'detaching a service')

  const remaining = { ...(manifest.services ?? {}) }
  delete remaining[key]
  const next: ProjectManifest = { ...manifest, services: remaining }

  // The volume name comes from the catalogue. A service the catalogue has
  // forgotten can still be detached — that is how a project gets unstuck — it
  // just cannot be told where its data went.
  let volume: string | null = null
  let catalogue: ServiceCatalogue | null = null
  try {
    catalogue = ctx.catalogue().catalogue
    const definition = catalogue.services[key]
    if (definition) volume = volumeName(definition, manifest.name)
  } catch {
    catalogue = null
  }

  const regenerated = persist(dir, next, Object.keys(remaining).length > 0 ? catalogue : null)

  return {
    project: manifest.name,
    removed: { key, host_port: attachment.host_port, volume },
    services: attachedServices(next, catalogue),
    compose_path: composePath(dir),
    compose_regenerated: regenerated.changed,
  }
}

export function renderServiceRemove(output: ServiceRemoveOutput): string[] {
  const { removed } = output
  const lines = [
    `Detached ${removed.key} from ${output.project}.`,
    `  released host port ${removed.host_port} — free for the next \`service add\`.`,
  ]
  if (removed.volume) {
    lines.push(`  kept volume ${removed.volume}; it is now an orphan (\`cproj volumes orphaned\`).`)
  } else {
    lines.push('  its volume was kept, but the catalogue no longer defines the service, so its name is unknown.')
  }
  lines.push(`  compose: ${output.compose_path}${output.compose_regenerated ? ' (regenerated)' : ' (unchanged)'}`)
  return lines
}

// ── list ─────────────────────────────────────────────────────────────────────

export function collectServiceList(ctx: Context, name: string | undefined): ServiceListOutput {
  const project = requireProject(ctx, name)
  const catalogue = catalogueIfNeeded(ctx, project.manifest)
  return {
    project: project.name,
    services: attachedServices(project.manifest, catalogue),
  }
}

export function renderServiceList(output: ServiceListOutput): string[] {
  if (output.services.length === 0) {
    return [`${output.project} has no services attached.`, '', `Attach one with: cproj service add ${output.project} postgres`]
  }
  const lines = [`${output.project} services:`]
  for (const service of output.services) {
    lines.push(`  ${service.display} (${service.key})`)
    lines.push(`    host :${service.host_port} → :${service.container_port}   ${service.connection_hint}`)
    lines.push(`    volume ${service.volume}`)
  }
  return lines
}

/** Shared by `new --services`: turn a `--services a,b` value into catalogue keys. */
export function parseServiceList(value: string): string[] {
  const keys = value
    .split(',')
    .map((part) => part.trim())
    .filter((part) => part.length > 0)
  if (keys.length === 0) {
    throw new CprojError('INVALID_ARGUMENT', '`--services` expects a comma-separated list of catalogue keys, e.g. postgres,redis.')
  }
  return [...new Set(keys)].sort()
}

/** Exported for `new`, which builds its own manifest before anything is on disk. */
export function resolveServices(catalogue: ServiceCatalogue, keys: readonly string[]): PortRequest[] {
  return keys.map((key) => {
    const definition = catalogue.services[key]
    if (!definition) {
      const known = Object.keys(catalogue.services).sort().join(', ')
      throw new CprojError('SERVICE_UNKNOWN', `The service catalogue defines no \`${key}\`. Known services: ${known || 'none'}.`, {
        service: key,
      })
    }
    return { key, definition }
  })
}
