/**
 * `bardolier down-all` and `bardolier eject` — `cli-spec.md` §6 (Lifecycle / SSD).
 *
 * `eject` is a removability check, then `down-all`, then a holder check, then
 * `diskutil eject`, in that order and with no way to skip a step. The order
 * among the last three is the point: containers bind-mounting the SSD are
 * holders too, so they come down first; and the holder check happens after,
 * when what remains is genuinely the user's own Xcode or shell. The
 * removability check comes first of all — a root may be a plain directory on
 * the internal disk (phase 10), and there is no point stopping every project
 * on the way to a `diskutil eject` that was never going to apply.
 *
 * With more than one configured root (phase 18), `eject` targets exactly one:
 * an explicit `[root]` argument, or — when only one configured root turns out
 * to be an actually-removable, mounted volume — that one implicitly. Anything
 * else (none, or more than one, removable) is INVALID_ARGUMENT naming every
 * configured root, because there is no safe guess among disks.
 *
 * **It never forces.** A held volume is EJECT_BLOCKED carrying `holders`, and
 * the user decides what to close (CLAUDE.md: safety over convenience). Forcing
 * an unmount out from under a running editor is the data loss this command
 * exists to prevent, so there is deliberately no `--force` flag to add later.
 *
 * The one thing it will do BEYOND stopping containers, and only with consent,
 * is stop the Docker ENGINE. Docker Desktop shares `/Volumes` into its VM and
 * keeps descriptors on the SSD for as long as that VM lives, so a disk whose
 * containers are all down can still be dissented by the runtime — and unlike
 * Xcode there is nothing on screen to quit and unlike Spotlight no retry that
 * ever succeeds. That made "fully quit Docker Desktop" the standing price of an
 * eject. Stopping the engine (`docker desktop stop`) is the smaller move that
 * actually works, and it is still the user's call: the prompt, or
 * `--stop-docker`. It is not a force — nothing is unmounted out from under
 * anything, and `docker desktop start` puts it back. What follows the stop is a
 * WAIT, not an immediate retry: the command returns when the engine is down,
 * and the VM helper that holds `/Volumes` goes a few seconds later.
 *
 * `down-all` stops the projects that are actually up, then sweeps any leftover
 * `bardolier-*` container no manifest claims — the residue of a deleted project or
 * of a compose file that has since been regenerated. Stopping every project
 * unconditionally would mean a `docker compose down` per project on the SSD;
 * this way the cost is proportional to what is running.
 */

import type { Context } from '../context.ts'
import type { RootConfig } from '../config.ts'
import { BardolierError } from '../errors.ts'
import { isActionableHolder, isRuntimeHolder } from '../device.ts'
import { devContainerName, isBardolierContainer, serviceContainerName } from '../naming.ts'
import { attachedKeys } from '../compose.ts'
import { discoverProjects, probeRoot } from '../projects.ts'
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
    .filter((name) => isBardolierContainer(name) && !known.has(name))
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

export type EjectOptions = {
  /**
   * Stop the Docker engine without asking, when the runtime is what refuses.
   * Consent given up front — this is the flag the app passes for its "Stop
   * Docker & eject" button, and how a script says yes with no terminal to
   * prompt at. It is not a force: it never applies to a holder the user could
   * close instead.
   */
  readonly stopDocker?: boolean
  /** Which configured root to eject (phase 18). Required when more than one qualifies. */
  readonly root?: string
}

/**
 * Which root `eject` targets. An explicit name wins; otherwise a single
 * configured root is unambiguous outright, and among several the only safe
 * implicit pick is the one that is both mounted and an actually-removable
 * volume — everything else must be named, because there is no safe guess
 * among disks (a plain internal directory is never what `eject` should reach
 * for on its own).
 */
async function pickEjectTarget(ctx: Context, name: string | undefined): Promise<RootConfig> {
  const roots = ctx.config.roots
  if (name !== undefined) {
    const root = roots.find((r) => r.name === name)
    if (!root) {
      throw new BardolierError(
        'INVALID_ARGUMENT',
        `Unknown root \`${name}\`. Configured roots: ${roots.map((r) => r.name).join(', ')}.`,
      )
    }
    return root
  }
  if (roots.length === 1) return roots[0]!

  const removable: RootConfig[] = []
  for (const root of roots) {
    const probe = probeRoot(root)
    if (probe.mounted && probe.volume && (await ctx.device.removable(probe.volume))) removable.push(root)
  }
  if (removable.length === 1) return removable[0]!

  throw new BardolierError(
    'INVALID_ARGUMENT',
    `More than one root is configured; say which to eject: ${roots.map((r) => r.name).join(', ')}.`,
  )
}

function toHolders(holders: readonly { pid: number; command: string; user: string | null; paths: readonly string[] }[]): EjectHolder[] {
  return holders.map((holder) => ({
    pid: holder.pid,
    command: holder.command,
    user: holder.user,
    paths: [...holder.paths],
  }))
}

/** The holder records a BardolierError is carrying, if any. */
function detailHolders(error: BardolierError): EjectHolder[] {
  const holders = error.details?.holders
  return Array.isArray(holders) ? (holders as EjectHolder[]) : []
}

export async function runEject(ctx: Context, options: EjectOptions = {}): Promise<EjectOutput> {
  const target = await pickEjectTarget(ctx, options.root)
  const ssd = probeRoot(target)
  if (!ssd.mounted || !ssd.volume) {
    throw new BardolierError('SSD_NOT_MOUNTED', `${ssd.path} is not readable; there is nothing to eject.`)
  }

  if (!(await ctx.device.removable(ssd.volume))) {
    // A local root (phase 10) is a fully supported mode, but `eject` means
    // `diskutil eject` — asked of `/` or another ordinary directory, that is
    // at best a no-op and at worst a request to unmount the wrong thing.
    // Checked before down-all, so a refusal here touches no container.
    throw new BardolierError(
      'EJECT_NOT_APPLICABLE',
      `${ssd.volume} is not a removable volume, so there is nothing to eject. Use \`bardolier down-all\` to stop every project instead.`,
    )
  }

  const down = await runDownAll(ctx)

  const holders: EjectHolder[] = toHolders(await ctx.device.holders(ssd.volume))

  if (holders.length > 0) {
    throw new BardolierError(
      'EJECT_BLOCKED',
      `${ssd.volume} is still held by ${holders.length} process(es): ${holders.map(describeHolder).join('; ')}. Close them and try again — bardolier will not force an unmount.`,
      { holders },
    )
  }

  let dockerStopped = false
  try {
    await ctx.device.eject(ssd.volume)
  } catch (error) {
    if (!(error instanceof BardolierError) || error.code !== 'EJECT_BLOCKED') throw error
    const held = await stopEngineFor(ctx, ssd.volume, error, options)
    if (held === null) throw error
    dockerStopped = true
    await ejectAfterEngineStop(ctx, ssd.volume, held)
  }

  return { volume: ssd.volume, ejected: true, stopped: down.stopped, holders: [], docker_stopped: dockerStopped, root: target.name }
}

/**
 * Decide whether the Docker engine is what stands in the way, ask, and stop it.
 *
 * Returns null when this refusal is not the runtime's — the caller then
 * rethrows `refusal` untouched, because diskutil's own words plus its dissenter
 * are already the right answer for an Xcode or an `mds_stores`. Otherwise the
 * engine is stopped and the runtime's holders come back, so the retry that
 * follows can name them if the disk still will not go. Throws a NEW
 * EJECT_BLOCKED only when the runtime IS the blocker and the engine did not
 * stop: consent refused, no terminal to ask at, or no `docker desktop` to run.
 * That error names Docker, because a blocked eject must always name something.
 */
async function stopEngineFor(
  ctx: Context,
  volume: string,
  refusal: BardolierError,
  options: EjectOptions,
): Promise<EjectHolder[] | null> {
  const dissenters = detailHolders(refusal)
  // Someone the user can act on said no. Theirs to close; never Docker's fault.
  if (dissenters.some((holder) => isActionableHolder(holder.command))) return null
  // A system agent said no. "Try again in a moment" is the true advice, and
  // stopping Docker would be a side effect that fixes nothing.
  if (dissenters.length > 0 && !dissenters.some((holder) => isRuntimeHolder(holder.command))) return null

  // Named by diskutil, or — when it refused without naming anyone — recovered
  // from lsof, which is the only place the runtime's hold is visible at all.
  const runtime = dissenters.filter((holder) => isRuntimeHolder(holder.command))
  const held = runtime.length > 0 ? runtime : toHolders(await ctx.device.runtimeHolders(volume))
  if (held.length === 0) return null

  const named = held.map(describeHolder).join('; ')
  if (!(await allowed(ctx, options, volume, named))) {
    throw new BardolierError(
      'EJECT_BLOCKED',
      `${volume} is held by Docker's virtual machine (${named}), which keeps the file share open until the engine stops — no retry and no app to quit will release it. Run \`bardolier eject --stop-docker\` (or \`docker desktop stop\`) and try again; \`docker desktop start\` brings it back.`,
      { holders: held, reason: 'runtime-holds-volume' },
    )
  }

  try {
    await ctx.docker.stopEngine()
  } catch (error) {
    const said = error instanceof BardolierError ? error.message : String(error)
    throw new BardolierError(
      'EJECT_BLOCKED',
      `${volume} is held by Docker's virtual machine (${named}), and the engine would not stop: ${said} Quit Docker Desktop and try again.`,
      { holders: held, reason: 'runtime-holds-volume' },
    )
  }
  return held
}

/**
 * How long the runtime is given to actually let go, and how often it is asked.
 *
 * `docker desktop stop` returns when the ENGINE reports itself down, which is
 * not the same moment the host stops holding the disk: the descriptors on
 * `/Volumes` belong to the VM helper (`com.apple.Virtualization.VirtualMachine`,
 * owned by launchd rather than by Docker), and that is torn down after the
 * command returns. Retrying immediately — which is what this did — raced that
 * teardown and lost, so the user was told to go and do by hand the thing that
 * had just been done, and quitting Docker Desktop got the credit that the
 * elapsed seconds had earned.
 *
 * So the retry waits for `lsof` to stop seeing the runtime rather than for the
 * command to return. The budget is bounded because a wait with no end is a hang,
 * and what follows a spent budget is a refusal that names who is still there —
 * never a force.
 */
const RELEASE_POLL_MS = 500
const RELEASE_POLLS = 30
const RELEASE_BUDGET_S = (RELEASE_POLLS * RELEASE_POLL_MS) / 1000

/**
 * Attempts at the unmount once the descriptors are gone. More than one because
 * DiskArbitration can still have the runtime registered as a client for a beat
 * after its files are closed, and that dissent clears itself.
 */
const EJECT_ATTEMPTS = 3
const EJECT_RETRY_MS = 1_000

/**
 * Who the runtime still is on this volume, and whether that is nobody.
 *
 * A probe that cannot answer counts as nobody rather than throwing: by this
 * point the actionable-holder check has already passed and the engine has
 * already been stopped, so a broken `lsof` must not turn into a holder-check
 * failure. It only decides how long to WAIT and who to name — the `diskutil
 * eject` that follows is what actually decides whether the disk goes.
 */
async function runtimeHoldersOrNone(ctx: Context, volume: string): Promise<EjectHolder[]> {
  try {
    return toHolders(await ctx.device.runtimeHolders(volume))
  } catch {
    return []
  }
}

async function runtimeReleased(ctx: Context, volume: string): Promise<boolean> {
  return (await runtimeHoldersOrNone(ctx, volume)).length === 0
}

/**
 * The unmount, after the engine has been stopped: wait for the hold to go, then
 * try — and keep the answer honest about which of those two failed.
 *
 * A refusal from anyone else (an Xcode that opened a file while we waited, a
 * Spotlight mid-write) is rethrown untouched, because its own dissenter and its
 * own advice are already right. Only the runtime's refusal — or a diskutil that
 * refuses naming nobody — is retried, and when the budget is spent it becomes an
 * EJECT_BLOCKED that says the engine is ALREADY stopped. That distinction is the
 * whole point: the old code answered this case with "run `--stop-docker`", which
 * is the flag the user had just used.
 */
async function ejectAfterEngineStop(ctx: Context, volume: string, held: EjectHolder[]): Promise<void> {
  for (let poll = 0; poll < RELEASE_POLLS; poll++) {
    if (await runtimeReleased(ctx, volume)) break
    await ctx.wait(RELEASE_POLL_MS)
  }

  let refusal: BardolierError | null = null
  let dissenters: EjectHolder[] = []
  for (let attempt = 1; ; attempt++) {
    try {
      await ctx.device.eject(volume)
      return
    } catch (error) {
      if (!(error instanceof BardolierError) || error.code !== 'EJECT_BLOCKED') throw error
      dissenters = detailHolders(error)
      // Somebody else refused this time — an Xcode that opened a file while we
      // waited, a Spotlight mid-write. Their refusal already carries its own
      // name and its own advice, and it is the honest answer to give back.
      if (dissenters.length > 0 && !dissenters.every((holder) => isRuntimeHolder(holder.command))) throw error
      refusal = error
      if (attempt >= EJECT_ATTEMPTS) break
      await ctx.wait(EJECT_RETRY_MS)
    }
  }

  // Who is left, now that the engine is down: whoever diskutil named, or
  // whoever lsof can still see. If BOTH say the runtime has gone, then this
  // refusal is not the runtime's and blaming Docker for it would be a guess —
  // diskutil's own words go back unchanged, holders and all.
  const still = dissenters.length > 0 ? dissenters : await runtimeHoldersOrNone(ctx, volume)
  if (still.length === 0 && refusal !== null) throw refusal

  const named = still.length > 0 ? still : held
  throw new BardolierError(
    'EJECT_BLOCKED',
    `${volume} still would not unmount ${RELEASE_BUDGET_S}s after the Docker engine was stopped — held by ${named.map(describeHolder).join('; ')}. The engine is already down, so there is nothing left for bardolier to stop: if Docker Desktop itself is still running, quit it and retry; otherwise give the volume a moment and retry.`,
    { holders: named, reason: 'runtime-holds-volume-after-stop' },
  )
}

/**
 * Consent for stopping the engine: the flag, or the prompt.
 *
 * A prompt that cannot be shown is a NO, not an error — with no terminal there
 * is nobody to ask, and the caller turns that into an EJECT_BLOCKED whose
 * advice is `--stop-docker`. Letting `confirm`'s own refusal escape would tell
 * the user to re-run with `--force`, a flag `eject` deliberately does not have.
 */
async function allowed(ctx: Context, options: EjectOptions, volume: string, named: string): Promise<boolean> {
  if (options.stopDocker === true) return true
  try {
    return await ctx.confirm(
      `${volume} is still held by Docker's virtual machine (${named}). Every container is already stopped. Stop the Docker engine to finish ejecting?`,
    )
  } catch {
    return false
  }
}

export function renderEject(output: EjectOutput): string[] {
  const lines: string[] = []
  if (output.stopped.length > 0) lines.push(`Stopped ${output.stopped.join(', ')}.`)
  lines.push(`Ejected ${output.volume} (root: ${output.root}). Safe to unplug.`)
  if (output.docker_stopped) lines.push('  Stopped the Docker engine to release the volume — `docker desktop start` when you need it.')
  return lines
}
