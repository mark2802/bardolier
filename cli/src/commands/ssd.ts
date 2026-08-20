/**
 * `cproj down-all` and `cproj eject` — `cli-spec.md` §6 (Lifecycle / SSD).
 *
 * `eject` is `down-all`, then a holder check, then `diskutil eject`, in that
 * order and with no way to skip a step. The order is the point: containers
 * bind-mounting the SSD are holders too, so they come down first; and the check
 * happens after, when what remains is genuinely the user's own Xcode or shell.
 *
 * **It never forces.** A held volume is EJECT_BLOCKED carrying `holders`, and
 * the user decides what to close (CLAUDE.md: safety over convenience). Forcing
 * an unmount out from under a running editor is the data loss this command
 * exists to prevent, so there is deliberately no `--force` flag to add later.
 *
 * `down-all` stops the projects that are actually up, then sweeps any leftover
 * `cproj-*` container no manifest claims — the residue of a deleted project or
 * of a compose file that has since been regenerated. Stopping every project
 * unconditionally would mean a `docker compose down` per project on the SSD;
 * this way the cost is proportional to what is running.
 */

import type { Context } from '../context.ts'
import { CprojError } from '../errors.ts'
import { devContainerName, isCprojContainer, serviceContainerName } from '../naming.ts'
import { attachedKeys } from '../compose.ts'
import { discoverProjects, probeSsd } from '../projects.ts'
import { observeState, runningNames } from '../workspace.ts'
import type { DownAllOutput, DownAllProject, EjectHolder, EjectOutput } from '../model/ssd.ts'
import { runDown } from './down.ts'

/** Every container name the discovered manifests account for. */
function knownContainers(ctx: Context): Set<string> {
  const names = new Set<string>()
  for (const project of discoverProjects(ctx.config).projects) {
    names.add(devContainerName(project.name))
    for (const key of attachedKeys(project.manifest)) names.add(serviceContainerName(project.name, key))
  }
  return names
}

export async function runDownAll(ctx: Context): Promise<DownAllOutput> {
  const discovery = discoverProjects(ctx.config)
  const projects: DownAllProject[] = discovery.projects.map((project) => ({ name: project.name, was_running: false }))

  if (!(await ctx.docker.available())) {
    // Nothing can be running without a daemon, so there is nothing to stop.
    // Reported rather than raised: `eject` needs an answer, and "Docker is
    // down" must not stand between the user and their disk.
    return { projects, stopped: [], stray_containers: [], docker_available: false }
  }

  const running = runningNames(await ctx.docker.runningContainers())
  const stopped: string[] = []

  for (const entry of projects) {
    const project = discovery.projects.find((p) => p.name === entry.name)
    if (!project) continue
    if (observeState(project.manifest, running).state === 'stopped') continue
    entry.was_running = true
    // Reuse `down` rather than calling composeDown here: it is the one place
    // that knows to regenerate a missing compose file before tearing down.
    await runDown(ctx, project.name)
    stopped.push(project.name)
  }

  const known = knownContainers(ctx)
  const strays = [...runningNames(await ctx.docker.runningContainers())]
    .filter((name) => isCprojContainer(name) && !known.has(name))
    .sort()
  for (const name of strays) await ctx.docker.removeContainer(name)

  return { projects, stopped: stopped.sort(), stray_containers: strays, docker_available: true }
}

export function renderDownAll(output: DownAllOutput): string[] {
  const lines: string[] = []
  if (!output.docker_available) {
    lines.push('Docker is not running, so nothing was up to stop.')
    return lines
  }
  if (output.stopped.length === 0) lines.push('Nothing was running.')
  else lines.push(`Stopped ${output.stopped.length} project(s): ${output.stopped.join(', ')}.`)
  if (output.stray_containers.length > 0) {
    lines.push(`Removed ${output.stray_containers.length} stray container(s): ${output.stray_containers.join(', ')}.`)
  }
  lines.push('  Data kept: named volumes and project directories are untouched.')
  return lines
}

// ── eject ────────────────────────────────────────────────────────────────────

function describeHolder(holder: EjectHolder): string {
  const who = holder.user ? ` (${holder.user})` : ''
  const where = holder.paths.length > 0 ? ` — ${holder.paths[0]}` : ''
  return `${holder.command} [pid ${holder.pid}]${who}${where}`
}

export async function runEject(ctx: Context): Promise<EjectOutput> {
  const ssd = probeSsd(ctx.config)
  if (!ssd.volumePresent) {
    throw new CprojError('SSD_NOT_MOUNTED', `Nothing is mounted at ${ssd.volume}; there is nothing to eject.`)
  }

  const down = await runDownAll(ctx)

  const holders: EjectHolder[] = (await ctx.device.holders(ssd.volume)).map((holder) => ({
    pid: holder.pid,
    command: holder.command,
    user: holder.user,
    paths: [...holder.paths],
  }))

  if (holders.length > 0) {
    throw new CprojError(
      'EJECT_BLOCKED',
      `${ssd.volume} is still held by ${holders.length} process(es): ${holders.map(describeHolder).join('; ')}. Close them and try again — cproj will not force an unmount.`,
      { holders },
    )
  }

  await ctx.device.eject(ssd.volume)

  return { volume: ssd.volume, ejected: true, stopped: down.stopped, holders: [] }
}

export function renderEject(output: EjectOutput): string[] {
  const lines: string[] = []
  if (output.stopped.length > 0) lines.push(`Stopped ${output.stopped.join(', ')}.`)
  lines.push(`Ejected ${output.volume}. Safe to unplug.`)
  return lines
}
