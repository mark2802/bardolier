/**
 * `bardolier status [<name>]` — the app's primary contract (`cli-spec.md` §7).
 *
 * READ-ONLY (§2). It reads manifests and asks Docker what is running; it never
 * writes, creates, or starts anything.
 *
 * Deliberate asymmetry with `list`: `status` does NOT raise SSD_NOT_MOUNTED.
 * With the SSD unplugged or Docker down it still succeeds, reporting
 * `ssd.mounted: false` / `docker.available: false` and empty arrays. That is
 * what makes it safe as the app's poll-on-open call (§8) — the menu can render
 * "SSD not mounted" instead of an error. Its only failure is PROJECT_NOT_FOUND
 * for a named project, exactly as §6 declares.
 */

import type { Context } from '../context.ts'
import { BardolierError } from '../errors.ts'
import { devContainerName, serviceContainerName } from '../naming.ts'
import { defaultRoot, discoverProjects, findProject, type DiscoveredProject } from '../projects.ts'
import { observeState, runningNames } from '../workspace.ts'
import { scanVolumes } from '../volumes.ts'
import { connectionHint } from '../catalogue.ts'
import { appUrl } from '../services.ts'
import { attachedExtraPorts } from '../extraports.ts'
import type { Status, StatusProject, StatusService } from '../model/status.ts'
import type { ServiceCatalogue } from '../model/catalogue.ts'

function buildProject(
  project: DiscoveredProject,
  running: Set<string>,
  catalogue: ServiceCatalogue | null,
): StatusProject {
  const { name, manifest } = project
  const attached = Object.entries(manifest.services ?? {}).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))

  const services: StatusService[] = []
  for (const [key, attachment] of attached) {
    const definition = catalogue?.services[key]
    // A key the catalogue no longer defines can't be described honestly —
    // there is no display name, container port, or hint to report. It is left
    // out here and surfaced by `doctor`'s `manifests` check rather than
    // rendered with invented values.
    if (!definition) continue
    services.push({
      key,
      display: definition.display,
      state: running.has(serviceContainerName(name, key)) ? 'running' : 'stopped',
      host_port: attachment.host_port,
      container_port: definition.container_port,
      connection_hint: connectionHint(key, definition, attachment.host_port, name),
    })
  }

  // Shared with the lifecycle commands so `up`/`down` and `status` can never
  // disagree about what "running" means.
  const observed = observeState(manifest, running)

  return {
    name,
    dir: project.dir,
    archetype: manifest.archetype,
    state: observed.state,
    services,
    dev_container: observed.devRunning ? devContainerName(name) : null,
    app_port: manifest.app_port ?? null,
    app_url: appUrl(manifest),
    extra_ports: attachedExtraPorts(manifest),
    root: project.root,
  }
}

export async function collectStatus(ctx: Context, projectName?: string | null): Promise<Status> {
  const discovery = discoverProjects(ctx.config)

  let selected = discovery.projects
  if (projectName) {
    const match = findProject(discovery, projectName)
    if (!match) {
      const broken = discovery.invalid.find((p) => p.name === projectName)
      if (broken) {
        throw new BardolierError('CONFIG_INVALID', `Project \`${projectName}\` has an unusable manifest: ${broken.reason}`)
      }
      throw new BardolierError(
        'PROJECT_NOT_FOUND',
        `No project named \`${projectName}\` in any configured root (${ctx.config.roots.map((r) => r.path).join(', ')}).`,
      )
    }
    selected = [match]
  }

  const dockerAvailable = await ctx.docker.available()
  const running = dockerAvailable ? runningNames(await ctx.docker.runningContainers()) : new Set<string>()

  // Only pay for the catalogue when something actually references it.
  const needsCatalogue = selected.some((p) => Object.keys(p.manifest.services ?? {}).length > 0)
  const catalogue = needsCatalogue ? ctx.catalogue().catalogue : null

  return {
    // `ssd.root` keeps reporting the default root's path so the field the app
    // already reads stays meaningful; `roots` (phase 18) is the complete view.
    ssd: { mounted: discovery.mounted, root: defaultRoot(ctx.config).path },
    roots: discovery.roots.map((root) => ({ name: root.name, path: root.path, mounted: root.mounted })),
    docker: { available: dockerAvailable },
    projects: selected.map((project) => buildProject(project, running, catalogue)),
    orphaned_volumes: await orphanedVolumes(ctx, discovery.mounted, dockerAvailable),
  }
}

/**
 * The §7 orphan list, shared with `volumes orphaned` so the app's reclaim view
 * and its menu can never disagree.
 *
 * `status` must not fail (it is the app's poll-on-open call), and the scan has
 * real failure modes — an unmounted SSD, an unreadable manifest, a daemon that
 * went away mid-call. Any of those means "bardolier cannot tell what is orphaned",
 * which is reported as an empty list, exactly as it reports no projects when
 * the SSD is absent. `bardolier volumes orphaned` is where the reason is raised.
 */
async function orphanedVolumes(ctx: Context, mounted: boolean, dockerAvailable: boolean) {
  if (!mounted || !dockerAvailable) return []
  try {
    const scan = await scanVolumes(ctx)
    return [...scan.orphans]
  } catch {
    return []
  }
}

export function renderStatus(status: Status): string[] {
  const lines: string[] = []
  const multipleRoots = status.roots !== undefined && status.roots.length > 1
  if (multipleRoots) {
    lines.push('Roots:')
    for (const root of status.roots ?? []) lines.push(`  ${root.name}  ${root.mounted ? 'mounted' : 'NOT MOUNTED'}  ${root.path}`)
  } else {
    lines.push(`SSD:    ${status.ssd.mounted ? 'mounted' : 'NOT MOUNTED'}  ${status.ssd.root}`)
  }
  lines.push(`Docker: ${status.docker.available ? 'available' : 'UNAVAILABLE'}`)
  lines.push('')

  if (status.projects.length === 0) {
    lines.push(status.ssd.mounted ? 'No projects.' : 'No projects visible while every root is unmounted.')
    return lines
  }

  for (const project of status.projects) {
    const root = multipleRoots ? `  (${project.root})` : ''
    lines.push(`${project.name}  [${project.archetype}]  ${project.state}${root}`)
    lines.push(`  dev container: ${project.dev_container ?? '—'}`)
    if (project.app_url) lines.push(`  dev server:    ${project.app_url}`)
    for (const port of project.extra_ports ?? []) lines.push(`  ${port.name}:   ${port.url}`)
    if (project.services.length === 0) {
      lines.push('  services: none')
    } else {
      lines.push('  services:')
      for (const service of project.services) {
        lines.push(
          `    ${service.display} (${service.key})  ${service.state}  host :${service.host_port} → :${service.container_port}  ${service.connection_hint}`,
        )
      }
    }
    lines.push('')
  }

  if (status.orphaned_volumes.length > 0) {
    lines.push('Orphaned volumes:')
    for (const volume of status.orphaned_volumes) {
      lines.push(`  ${volume.name}  ${volume.size_human}  (was ${volume.last_project ?? 'unknown'})`)
    }
  }

  while (lines.length > 0 && lines[lines.length - 1] === '') lines.pop()
  return lines
}
