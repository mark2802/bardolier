/**
 * `cproj up <name> [--no-shell]` — `cli-spec.md` §6 (Projects).
 *
 * Three things happen, in this order, and the order matters:
 *
 *   1. Regenerate the compose file from the manifest. The manifest is the truth
 *      (§4.2); starting from a stale or hand-edited compose file would start
 *      something the manifest does not describe.
 *   2. Validate every recorded host port is still bindable (§5). A port squatted
 *      while the project was down fails PORT_UNAVAILABLE naming the port — never
 *      a silent remap, which would break saved connection strings.
 *   3. `docker compose up -d`.
 *
 * Idempotent (§2): `up` on a running project is a no-op success. The CLI never
 * spawns a terminal — `open_shell` only tells the app what the user asked for.
 */

import type { Context } from '../context.ts'
import { CprojError } from '../errors.ts'
import { composeProject, devContainerName, serviceContainerName } from '../naming.ts'
import { attachedKeys } from '../compose.ts'
import type { UpOutput, UpService } from '../model/lifecycle.ts'
import type { ProjectManifest } from '../model/project.ts'
import type { ServiceCatalogue } from '../model/catalogue.ts'
import { composePath, observeProject, regenerateCompose, requireProject } from '../workspace.ts'

/** The catalogue is needed only when something is attached (§4.1 chain can fail). */
function catalogueFor(ctx: Context, manifest: ProjectManifest): ServiceCatalogue | null {
  return attachedKeys(manifest).length > 0 ? ctx.catalogue().catalogue : null
}

/**
 * Check the ports we are about to publish. Ports already held by this project's
 * own running containers are skipped — they are "taken" by us, which is the
 * whole point of `up` being idempotent.
 */
async function validatePorts(
  ctx: Context,
  manifest: ProjectManifest,
  alreadyRunning: readonly string[],
): Promise<void> {
  const running = new Set(alreadyRunning)
  for (const key of attachedKeys(manifest)) {
    if (running.has(key)) continue
    const port = manifest.services?.[key]?.host_port
    if (port === undefined) continue
    if (!(await ctx.ports.isFree(port))) {
      throw new CprojError(
        'PORT_UNAVAILABLE',
        `Host port ${port} (for \`${key}\` in \`${manifest.name}\`) is already in use. cproj will not remap it — free the port, or remove and re-add the service to assign a new one.`,
        { port, service: key, project: manifest.name },
      )
    }
  }
}

export type UpRequest = {
  readonly name: string | undefined
  readonly noShell: boolean
}

export async function runUp(ctx: Context, request: UpRequest): Promise<UpOutput> {
  const project = requireProject(ctx, request.name)
  const { manifest, dir } = project

  const catalogue = catalogueFor(ctx, manifest)
  const regenerated = regenerateCompose(dir, manifest, catalogue)

  const before = await observeProject(ctx, manifest)
  const alreadyRunning = before.state === 'running'

  if (!alreadyRunning) {
    await validatePorts(ctx, manifest, before.runningServices)
    await ctx.docker.composeUp({
      file: composePath(dir),
      project: composeProject(manifest.name),
      cwd: dir,
    })
  }

  const after = alreadyRunning ? before : await observeProject(ctx, manifest)

  const services: UpService[] = []
  for (const key of attachedKeys(manifest)) {
    const attachment = manifest.services?.[key]
    const definition = catalogue?.services[key]
    if (!attachment || !definition) continue
    services.push({ key, host_port: attachment.host_port, container_port: definition.container_port })
  }

  return {
    project: manifest.name,
    state: after.state,
    dev_container: devContainerName(manifest.name),
    services,
    already_running: alreadyRunning,
    compose_regenerated: regenerated.changed,
    open_shell: !request.noShell,
  }
}

export function renderUp(output: UpOutput): string[] {
  const lines: string[] = []
  lines.push(
    output.already_running
      ? `${output.project} is already up (${output.state}).`
      : `${output.project} is ${output.state}.`,
  )
  lines.push(`  dev container: ${output.dev_container}`)
  if (output.services.length > 0) {
    lines.push('  services:')
    for (const service of output.services) {
      lines.push(`    ${service.key}  host :${service.host_port} → :${service.container_port}`)
    }
  }
  if (output.compose_regenerated) lines.push('  (docker-compose.yml regenerated from project.yml)')
  if (output.state !== 'running') {
    lines.push('')
    lines.push(`Not everything came up — run \`cproj status ${output.project}\` for detail.`)
  } else {
    lines.push('')
    lines.push(`Shell in with: docker exec -it ${output.dev_container} bash`)
  }
  return lines
}

/** Exported for `down`/`delete`, which name the same containers. */
export function containerNames(manifest: ProjectManifest): string[] {
  return [
    devContainerName(manifest.name),
    ...attachedKeys(manifest).map((key) => serviceContainerName(manifest.name, key)),
  ]
}
