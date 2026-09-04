/**
 * Writing side of a project directory — the counterpart to `projects.ts`,
 * which only reads.
 *
 * Everything that mutates a project goes through here so three invariants hold
 * in one place rather than in four commands:
 *
 *   1. `project.yml` is written with a stable key order (§4.2), so an unchanged
 *      manifest round-trips to identical bytes.
 *   2. `docker-compose.yml` is REGENERATED, never patched — and regeneration is
 *      a no-op write when the content already matches, so `up` on an untouched
 *      project leaves no mtime churn and no diff.
 *   3. A mutating command resolves its project through `requireProject`, which
 *      is the single place SSD_NOT_MOUNTED / PROJECT_NOT_FOUND are raised.
 */

import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { stringify as stringifyYaml } from 'yaml'
import type { Context } from './context.ts'
import { CprojError } from './errors.ts'
import type { DockerContainer } from './docker.ts'
import { COMPOSE_FILENAME, renderCompose } from './compose.ts'
import { devContainerName, serviceContainerName } from './naming.ts'
import { MANIFEST_FILENAME, discoverProjects, type DiscoveredProject } from './projects.ts'
import type { ProjectManifest } from './model/project.ts'
import type { ServiceCatalogue } from './model/catalogue.ts'
import type { ProjectState } from './model/status.ts'

const MANIFEST_HEADER = [
  '# cproj project manifest — the source of truth for this project.',
  '#',
  '# Edit this file, then run `cproj up` to regenerate docker-compose.yml from it.',
  '# Host ports are assigned once and stay put (cli-spec.md §5); changing one here',
  '# will break saved connection strings, so prefer service remove/add.',
  '',
].join('\n')

/** Key order for the written manifest — §4.2's order, so diffs stay readable. */
export function orderManifest(manifest: ProjectManifest): Record<string, unknown> {
  const ordered: Record<string, unknown> = {
    name: manifest.name,
    archetype: manifest.archetype,
    base_image: manifest.base_image,
  }
  // Right after base_image, because it's the same kind of thing — what the
  // dev container actually runs (Phase 13, `deps.ts`) — before the ports.
  const packages = manifest.extra_packages ?? []
  if (packages.length > 0) ordered.extra_packages = [...packages].sort()
  const services = manifest.services ?? {}
  const keys = Object.keys(services).sort()
  if (keys.length > 0) {
    const sorted: Record<string, unknown> = {}
    for (const key of keys) sorted[key] = { host_port: services[key]?.host_port }
    ordered.services = sorted
  }
  // After the services, because it is the same kind of thing — a host port
  // assigned once and kept (§5, §9) — and before `created`, which stays last.
  if (typeof manifest.app_port === 'number') ordered.app_port = manifest.app_port
  const extraPorts = manifest.extra_ports ?? {}
  const extraPortNames = Object.keys(extraPorts).sort()
  if (extraPortNames.length > 0) {
    const sorted: Record<string, unknown> = {}
    for (const name of extraPortNames) {
      sorted[name] = { container_port: extraPorts[name]?.container_port, host_port: extraPorts[name]?.host_port }
    }
    ordered.extra_ports = sorted
  }
  ordered.created = manifest.created
  return ordered
}

export function renderManifest(manifest: ProjectManifest): string {
  return `${MANIFEST_HEADER}${stringifyYaml(orderManifest(manifest), { indent: 2, lineWidth: 0 })}`
}

export function manifestPath(dir: string): string {
  return join(dir, MANIFEST_FILENAME)
}

export function composePath(dir: string): string {
  return join(dir, COMPOSE_FILENAME)
}

export function writeManifest(dir: string, manifest: ProjectManifest): string {
  const path = manifestPath(dir)
  writeFileSync(path, renderManifest(manifest))
  return path
}

/** Read a file, or null when it does not exist. */
function readIfPresent(path: string): string | null {
  try {
    return readFileSync(path, 'utf8')
  } catch {
    return null
  }
}

export type Regeneration = {
  readonly path: string
  /** True when the file was absent or its content differed from the manifest. */
  readonly changed: boolean
}

/**
 * Rewrite `docker-compose.yml` from the manifest. Skips the write when the
 * bytes already match — determinism (§9) is what makes that check meaningful,
 * and it is how `up` can report `compose_regenerated: false` truthfully.
 */
export function regenerateCompose(
  dir: string,
  manifest: ProjectManifest,
  catalogue: ServiceCatalogue | null,
): Regeneration {
  const path = composePath(dir)
  const next = renderCompose({ manifest, catalogue })
  if (readIfPresent(path) === next) return { path, changed: false }
  writeFileSync(path, next)
  return { path, changed: true }
}

/**
 * Resolve a project for a MUTATING command. Unlike `status`, an absent SSD is
 * fatal here: there is nothing to mutate and pretending otherwise would create
 * a project directory on the internal disk.
 */
export function requireProject(ctx: Context, name: string | undefined): DiscoveredProject {
  if (!name) throw new CprojError('INVALID_ARGUMENT', 'A project name is required.')
  const discovery = discoverProjects(ctx.config)
  if (!discovery.mounted) {
    throw new CprojError('SSD_NOT_MOUNTED', `The SSD is not mounted at ${ctx.config.ssd_root}.`)
  }
  const found = discovery.projects.find((p) => p.name === name)
  if (found) return found

  const broken = discovery.invalid.find((p) => p.name === name)
  if (broken) {
    throw new CprojError('CONFIG_INVALID', `Project \`${name}\` has an unusable manifest: ${broken.reason}`)
  }
  throw new CprojError('PROJECT_NOT_FOUND', `No project named \`${name}\` under ${ctx.config.ssd_root}.`)
}

/** Every name every running container answers to. */
export function runningNames(containers: readonly DockerContainer[]): Set<string> {
  const names = new Set<string>()
  for (const container of containers) {
    if (container.state !== 'running') continue
    for (const name of container.names) names.add(name)
  }
  return names
}

export type ObservedState = {
  readonly state: ProjectState
  readonly devRunning: boolean
  /** Attached service keys currently up. */
  readonly runningServices: readonly string[]
}

/**
 * The §7 state rule, in one place: `running` only when the dev container AND
 * every attached service are up. Counting ATTACHED services (not merely
 * describable ones) is what stops a service the catalogue no longer defines
 * from making a half-running project look fully running.
 */
export function observeState(manifest: ProjectManifest, running: Set<string>): ObservedState {
  const attached = Object.keys(manifest.services ?? {}).sort()
  const devRunning = running.has(devContainerName(manifest.name))
  const runningServices = attached.filter((key) => running.has(serviceContainerName(manifest.name, key)))

  const expected = 1 + attached.length
  const up = (devRunning ? 1 : 0) + runningServices.length
  const state: ProjectState = up === 0 ? 'stopped' : up === expected ? 'running' : 'partial'
  return { state, devRunning, runningServices }
}

/** Ask Docker what is up right now. Returns an empty set when the daemon is down. */
export async function observeProject(ctx: Context, manifest: ProjectManifest): Promise<ObservedState> {
  const available = await ctx.docker.available()
  const running = available ? runningNames(await ctx.docker.runningContainers()) : new Set<string>()
  return observeState(manifest, running)
}
