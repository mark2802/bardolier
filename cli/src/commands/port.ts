/**
 * `bardolier port add | remove | list` — `cli-spec.md` §6 (Ports), §5.1.
 *
 * The gap this closes (`docs/development/migration-guide-gaps.md`, now resolved): a
 * project whose backend a mobile client must reach directly, a second
 * frontend/UI app, or a browser-reachable dev tool on an archetype that
 * otherwise publishes nothing (`library` and friends). All three are the same
 * shape — a NAMED port, independent of archetype, published from the dev
 * container — so one mechanism serves all of them rather than three.
 *
 * Unlike a service, there is no catalogue behind an extra port: the caller
 * states the container-side port and the allocator finds a free host port
 * starting there (`allocateExtraPort`), exactly as `app_port` does for the
 * archetype's own dev server. Add/remove REQUIRE THE PROJECT STOPPED, for the
 * same reason service add/remove do (`service.ts`) — `requireStopped` and
 * `persist` are shared with it rather than reimplemented.
 */

import type { Context } from '../context.ts'
import { BardolierError } from '../errors.ts'
import { allocateExtraPort } from '../allocator.ts'
import { attachedExtraPorts, describeExtraPort } from '../extraports.ts'
import type { ProjectManifest } from '../model/project.ts'
import type { PortAddOutput, PortListOutput, PortRemoveOutput } from '../model/extraport.ts'
import { composePath, requireProject } from '../workspace.ts'
import { discoverProjects } from '../projects.ts'
import { offlineRoots, renderDegradedRoots } from '../rootindex.ts'
import { catalogueIfNeeded, persist, requireStopped } from './service.ts'

/** Mirrors `project.schema.json`'s `extra_ports` key pattern — also a service key's. */
const NAME_PATTERN = /^[a-z0-9][a-z0-9._-]*$/

// Same floor as a service's host_port (project.schema.json): low enough for
// nothing a dev tool plausibly wants, and it keeps every allocated port well
// clear of a privileged range some host might restrict.
const MIN_PORT = 1024
const MAX_PORT = 65535

export type PortRequest = {
  readonly project: string | undefined
  readonly name: string | undefined
}

export type PortAddRequest = PortRequest & {
  readonly containerPort: string | undefined
}

function requireName(value: string | undefined, usage: string): string {
  if (!value) throw new BardolierError('INVALID_ARGUMENT', `Usage: bardolier ${usage}`)
  if (!NAME_PATTERN.test(value)) {
    throw new BardolierError(
      'INVALID_ARGUMENT',
      `\`${value}\` is not a usable port name: use lower-case letters, digits, dot, dash or underscore, starting with a letter or digit.`,
    )
  }
  return value
}

function requireContainerPort(value: string | undefined): number {
  if (!value) throw new BardolierError('INVALID_ARGUMENT', '`--container-port` is required, e.g. --container-port 8888.')
  const port = Number(value)
  if (!Number.isInteger(port) || port < MIN_PORT || port > MAX_PORT) {
    throw new BardolierError('INVALID_ARGUMENT', `\`--container-port ${value}\` is not a usable port (${MIN_PORT}-${MAX_PORT}).`)
  }
  return port
}

// ── add ──────────────────────────────────────────────────────────────────────

export async function runPortAdd(ctx: Context, request: PortAddRequest): Promise<PortAddOutput> {
  const project = requireProject(ctx, request.project)
  const name = requireName(request.name, 'port add <project> <name> --container-port <n>')
  const containerPort = requireContainerPort(request.containerPort)
  const { manifest, dir } = project

  if (manifest.extra_ports?.[name]) {
    throw new BardolierError(
      'EXTRA_PORT_ATTACHED',
      `\`${name}\` is already declared on \`${manifest.name}\` on host port ${manifest.extra_ports[name].host_port}.`,
      { project: manifest.name, name, host_port: manifest.extra_ports[name].host_port },
    )
  }

  await requireStopped(ctx, project, 'declaring an extra port')

  const hostPort = await allocateExtraPort(ctx, manifest.name, name, containerPort)

  const next: ProjectManifest = {
    ...manifest,
    extra_ports: { ...(manifest.extra_ports ?? {}), [name]: { container_port: containerPort, host_port: hostPort } },
  }
  const catalogue = catalogueIfNeeded(ctx, next)
  const regenerated = persist(ctx, dir, next, catalogue)
  const degraded = offlineRoots(ctx, discoverProjects(ctx.config))

  return {
    project: manifest.name,
    added: describeExtraPort(name, { container_port: containerPort, host_port: hostPort }),
    extra_ports: attachedExtraPorts(next),
    compose_path: composePath(dir),
    compose_regenerated: regenerated.changed,
    ...(degraded.length > 0 ? { degraded_roots: degraded } : {}),
  }
}

export function renderPortAdd(output: PortAddOutput): string[] {
  const { added } = output
  return [
    `Declared port \`${added.name}\` on ${output.project}.`,
    `  host port: ${added.host_port} → :${added.container_port}   ${added.url}`,
    `  compose:   ${output.compose_path}${output.compose_regenerated ? ' (regenerated)' : ' (unchanged)'}`,
    ...renderDegradedRoots(output.degraded_roots ?? []),
    '',
    `Next: bardolier up ${output.project}`,
  ]
}

// ── remove ───────────────────────────────────────────────────────────────────

export async function runPortRemove(ctx: Context, request: PortRequest): Promise<PortRemoveOutput> {
  const project = requireProject(ctx, request.project)
  const name = requireName(request.name, 'port remove <project> <name>')
  const { manifest, dir } = project

  const attachment = manifest.extra_ports?.[name]
  if (!attachment) {
    const declared = Object.keys(manifest.extra_ports ?? {}).sort().join(', ')
    throw new BardolierError(
      'EXTRA_PORT_NOT_ATTACHED',
      `\`${name}\` is not declared on \`${manifest.name}\`.${declared ? ` Declared: ${declared}.` : ''}`,
      { project: manifest.name, name },
    )
  }

  await requireStopped(ctx, project, 'removing an extra port')

  const remaining = { ...(manifest.extra_ports ?? {}) }
  delete remaining[name]
  const next: ProjectManifest = { ...manifest, extra_ports: remaining }

  const catalogue = catalogueIfNeeded(ctx, next)
  const regenerated = persist(ctx, dir, next, catalogue)

  return {
    project: manifest.name,
    removed: { name, host_port: attachment.host_port },
    extra_ports: attachedExtraPorts(next),
    compose_path: composePath(dir),
    compose_regenerated: regenerated.changed,
  }
}

export function renderPortRemove(output: PortRemoveOutput): string[] {
  const { removed } = output
  return [
    `Removed port \`${removed.name}\` from ${output.project}.`,
    `  released host port ${removed.host_port} — free for the next \`port add\`.`,
    `  compose: ${output.compose_path}${output.compose_regenerated ? ' (regenerated)' : ' (unchanged)'}`,
  ]
}

// ── list ─────────────────────────────────────────────────────────────────────

export function collectPortList(ctx: Context, name: string | undefined): PortListOutput {
  const project = requireProject(ctx, name)
  return { project: project.name, extra_ports: attachedExtraPorts(project.manifest) }
}

export function renderPortList(output: PortListOutput): string[] {
  if (output.extra_ports.length === 0) {
    return [`${output.project} has no extra ports declared.`, '', `Declare one with: bardolier port add ${output.project} notebook --container-port 8888`]
  }
  const lines = [`${output.project} extra ports:`]
  for (const port of output.extra_ports) {
    lines.push(`  ${port.name}`)
    lines.push(`    host :${port.host_port} → :${port.container_port}   ${port.url}`)
  }
  return lines
}
