/**
 * The SSD seam — the two host-side things `eject` has to do that Docker cannot:
 * ask WHO is holding the volume, and unmount it. `cli-spec.md` §6
 * (Lifecycle / SSD).
 *
 * Both are macOS commands (`lsof`, `diskutil`) and both are irreversible-ish
 * enough that a command must never spawn them itself: they live behind this
 * seam so `eject` can be exercised with a scripted holder set on a machine with
 * no SSD, exactly as `docker.ts` does for the daemon.
 *
 * The safety rule from CLAUDE.md is encoded here: **never force**. If holders
 * cannot be determined, that is a refusal (EJECT_BLOCKED naming the reason),
 * not a licence to eject blind — unmounting a disk out from under a running
 * Xcode is precisely the data loss the command exists to prevent.
 */

import { execFile } from 'node:child_process'
import { BandolierError } from './errors.ts'

/** A process holding files open on the volume. Rendered by the app on refusal. */
export type Holder = {
  readonly pid: number
  /** Process name as the OS reports it, e.g. `Xcode`, `zsh`. */
  readonly command: string
  /** Login name of the owner, or null when the probe did not say. */
  readonly user: string | null
  /** Paths under the volume this process holds, sorted, at most a few. */
  readonly paths: readonly string[]
}

export type SsdDevice = {
  /**
   * Processes holding `mountPoint` that the USER can act on. The container
   * runtime and the OS's own volume agents are filtered out — see
   * `isActionableHolder` for why an unfiltered list refuses forever. Empty
   * means nothing stands between the user and an unmount.
   */
  holders(mountPoint: string): Promise<readonly Holder[]>
  /**
   * The container runtime's own hold on `mountPoint`, which `holders()` leaves
   * out on purpose. Nothing consults this to decide whether to eject — only to
   * NAME Docker once `diskutil` has already refused, so a refusal caused by the
   * VM's file share says so instead of arriving with an empty list.
   */
  runtimeHolders(mountPoint: string): Promise<readonly Holder[]>
  /** Unmount and power down the volume. Throws EJECT_BLOCKED if it will not go. */
  eject(mountPoint: string): Promise<void>
  /**
   * True when `mountPoint` is a removable volume `diskutil` can eject — false
   * for an ordinary directory on the internal disk, and false (never a throw)
   * on any probe failure, matching the "never force" posture: a probe that
   * cannot tell is refused as inapplicable, not attempted anyway.
   */
  removable(mountPoint: string): Promise<boolean>
}

export type HostResult = {
  readonly code: number
  readonly stdout: string
  readonly stderr: string
}

/** Spawns a host binary. Replaced wholesale in tests. */
export type HostRunner = (command: string, args: readonly string[]) => Promise<HostResult>

const HOST_TIMEOUT_MS = 20_000

export function execHost(timeoutMs = HOST_TIMEOUT_MS): HostRunner {
  return (command, args) =>
    new Promise((resolve) => {
      execFile(command, [...args], { timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024 }, (error, stdout, stderr) => {
        if (error) {
          // A non-zero EXIT is not the same as a failure to run, and the
          // difference matters: `lsof` exits 1 with no output to mean "nothing
          // matched", which is an answer. Only a spawn failure or a timeout
          // (no numeric exit code) gets Node's message put in stderr — filling
          // it in for an ordinary exit would turn that answer into an error.
          const exitCode = typeof error.code === 'number' ? error.code : null
          resolve({
            code: exitCode ?? -1,
            stdout: stdout ?? '',
            stderr: stderr || (exitCode === null ? error.message : ''),
          })
          return
        }
        resolve({ code: 0, stdout: stdout ?? '', stderr: stderr ?? '' })
      })
    })
}

/** How many paths per holder to keep — enough to recognise it, not a file listing. */
const MAX_PATHS = 5

/**
 * Holders that must not, on their own, refuse an eject.
 *
 * Two kinds of process show up in `lsof` on a mounted volume that the user
 * cannot act on, for two different reasons.
 *
 * The CONTAINER RUNTIME keeps directory descriptors open on every bind-mounted
 * path for as long as the file share exists — including after `down-all` has
 * stopped every container. Listing it would mean "quit Docker Desktop" is the
 * standing answer to every eject, which is not what §6's holder check is for:
 * it names Xcode, the Simulator, and shells cd'd into the SSD — processes the
 * user can see and quit.
 *
 * The SYSTEM VOLUME AGENTS are worse, because they never go away at all.
 * Spotlight's `mds`/`mds_stores` keep `.Spotlight-V100` mapped for as long as
 * the disk is mounted, by design; QuickLook and the Dock's preview agents open
 * every file in whatever folder a Finder window happens to be showing. A holder
 * check that counts them refuses FOREVER on an indexed SSD — there is no app to
 * quit and no work to wait out, so "Close all & eject" simply never succeeds.
 *
 * Neither list is a licence to force, and neither is a guess that these
 * processes will cope. They are DiskArbitration clients, and asking them to let
 * go IS the unmount protocol — that is what `diskutil eject` does next. When one
 * genuinely does not let go, `diskutil` dissents, `parseDissenter` recovers the
 * name from its refusal, and the user gets a holder to act on after all: later
 * than `lsof` would have named it, but true rather than permanent.
 */
const VIRTUALISATION_HOLDERS = [
  'com.docker',
  'Docker',
  'com.apple.Virtualization',
  'virtiofsd', // the file-share daemon itself, which is what actually holds /Volumes
  'vpnkit',
  'qemu',
] as const

/**
 * Prefixes matched against the process name. `lsof -F` gives 31 characters of
 * it rather than the human column format's 9 — enough for `mds_stores` to read
 * as itself instead of `mds_store` — but it is still a truncation, which is why
 * every entry here is a PREFIX that fits well inside 31 characters rather than
 * a name to compare for equality.
 */
const SYSTEM_HOLDERS = [
  'mds', // mds, mds_stores, mdsync — Spotlight's indexer and its store
  'mdworker', // the per-file importers it forks
  'mdbulkimport',
  'Spotlight',
  'fseventsd', // the volume's own change journal
  'revisiond', // .DocumentRevisions-V100
  'diskarbitrationd', // the thing performing the unmount
  'quicklookd',
  'QuickLook',
  'com.apple.quicklook', // ThumbnailsAgent, satellite — Finder icon previews
  'com.apple.dock.extra', // Stacks previews: the same walk over the same folder
] as const

/**
 * The process name, whichever way the host spelled it.
 *
 * The two probes do not agree on that. `lsof` reports a bare name
 * (`com.apple.Virtualization.Virtua`); `diskutil` names its dissenter by FULL
 * EXECUTABLE PATH — `/System/Library/Frameworks/Virtualization.framework/…/
 * MacOS/com.apple.Virtualization.VirtualMachine`. The lists above are names, so
 * a path is reduced to its last component before it is matched against them.
 * Without that, Docker's own VM — named the only way `diskutil` knows how to
 * name it — reads as an ordinary app, and the user is told to close a thing
 * that has no window, instead of being offered the engine stop that works.
 */
export function processName(command: string): string {
  const base = command.slice(command.lastIndexOf('/') + 1)
  return base.length > 0 ? base : command
}

/** Prefix match against the command as given AND against its bare name. */
function matchesAny(command: string, prefixes: readonly string[]): boolean {
  const name = processName(command)
  return prefixes.some((prefix) => command.startsWith(prefix) || name.startsWith(prefix))
}

/** True for a process whose open descriptors belong to the container runtime. */
export function isRuntimeHolder(command: string): boolean {
  return matchesAny(command, VIRTUALISATION_HOLDERS)
}

/**
 * True for an OS agent that holds every mounted volume open as a matter of
 * course, and relinquishes it when the unmount asks.
 */
export function isSystemHolder(command: string): boolean {
  return matchesAny(command, SYSTEM_HOLDERS)
}

/** True when a holder is something the user can see, quit, and try again. */
export function isActionableHolder(command: string): boolean {
  return !isRuntimeHolder(command) && !isSystemHolder(command)
}

/**
 * Parse `lsof -F pcLn` output.
 *
 * lsof's machine format is one field per line, tagged by its first character,
 * grouped into process records: `p<pid>`, `c<command>`, `L<login>`, then a
 * file record per open file with `n<path>`. Anything else is ignored.
 */
export function parseLsof(stdout: string, mountPoint: string): Holder[] {
  const byPid = new Map<number, { command: string; user: string | null; paths: Set<string> }>()
  let current: { command: string; user: string | null; paths: Set<string> } | null = null

  for (const line of stdout.split('\n')) {
    if (line.length === 0) continue
    const tag = line[0]
    const value = line.slice(1)
    if (tag === 'p') {
      const pid = Number.parseInt(value, 10)
      if (!Number.isFinite(pid)) {
        current = null
        continue
      }
      current = byPid.get(pid) ?? { command: '', user: null, paths: new Set<string>() }
      byPid.set(pid, current)
    } else if (tag === 'c' && current) {
      current.command = value
    } else if (tag === 'L' && current) {
      current.user = value.length > 0 ? value : null
    } else if (tag === 'n' && current) {
      // Only paths under the volume itself; lsof reports sockets and pipes too.
      if (value.startsWith(mountPoint)) current.paths.add(value)
    }
  }

  return [...byPid.entries()]
    .map(([pid, held]): Holder => ({
      pid,
      command: held.command || 'unknown',
      user: held.user,
      paths: [...held.paths].sort().slice(0, MAX_PATHS),
    }))
    .sort((a, b) => a.pid - b.pid)
}

/**
 * Recover the holder from `diskutil`'s own refusal.
 *
 * When an unmount is dissented, DiskArbitration knows exactly which process
 * said no, and `diskutil` prints it — in a shape that has drifted across macOS
 * releases (`Dissenter PID = 51310 (plugin_host-3.8), Status = 0x0000c010`,
 * `dissented by PID 51310 (plugin_host)`, and on Sequoia `Unmount was dissented
 * by PID 74033 (/System/Library/…/com.apple.Virtualization.VirtualMachine)`).
 * What every variant carries is `PID <n> (<what>)`, so that is what this looks
 * for and nothing more — and `<what>` is reduced to a process name, because in
 * the newest shape it is an absolute path and both the classifier and the
 * user's eye want the name at the end of it. The `\b` is what keeps the
 * `Dissenter parent PPID 1 (/sbin/launchd)` line on the next line out: launchd
 * is nobody's holder.
 *
 * This is the answer `lsof` cannot give. `holders()` runs unprivileged — a GUI
 * app has no way to become root — so it never sees another user's processes at
 * all, and a root dissenter like `mds_stores` is named here or nowhere. A
 * refusal with no PID in it stays a refusal with no holders: inventing one
 * would be worse than an empty list.
 */
export function parseDissenter(text: string): Holder[] {
  const byPid = new Map<number, Holder>()
  for (const match of text.matchAll(/\bPID\s*=?\s*(\d+)\s*\(([^)]*)\)/g)) {
    const pid = Number.parseInt(match[1] ?? '', 10)
    if (!Number.isFinite(pid) || byPid.has(pid)) continue
    const named = (match[2] ?? '').trim()
    const command = named.length > 0 ? processName(named) : 'unknown'
    byPid.set(pid, { pid, command, user: null, paths: [] })
  }
  return [...byPid.values()].sort((a, b) => a.pid - b.pid)
}

/**
 * Read a `<key>NAME</key>` boolean out of `diskutil info -plist` output.
 *
 * A full plist parser is more than this needs: the two keys that matter
 * (`Ejectable`, `Internal`) are always emitted as a `<key>`/`<true/>`|`<false/>`
 * pair, so a regex finds them without pulling in an XML parser for one probe.
 * Null means the key was not there at all — a plain directory that is not a
 * distinct volume at all, which `diskutil info` answers about the containing
 * disk (or not at all), never with these two keys both present and false.
 */
function plistBool(plist: string, key: string): boolean | null {
  const match = plist.match(new RegExp(`<key>${key}</key>\\s*<(true|false)/>`))
  if (!match) return null
  return match[1] === 'true'
}

/** `command [pid n]`, the one shape both this file and `eject`'s renderer use. */
function nameHolders(holders: readonly Holder[]): string {
  return holders.map((holder) => `${holder.command} [pid ${holder.pid}]`).join('; ')
}

/**
 * What to tell the user about a dissenter, which is not the same sentence for
 * both kinds. "Close it and try again" is the right advice for Xcode and dead
 * wrong for `mds_stores` — there is nothing to close, and the honest answer is
 * that Spotlight was mid-write and a second attempt will very likely take.
 */
function adviseOn(holders: readonly Holder[]): string {
  if (holders.length === 0) return ''
  if (holders.every((holder) => isRuntimeHolder(holder.command))) {
    // The one dissenter that is neither "close it" nor "wait": Docker's VM
    // holds the file share for as long as it is alive, so no amount of
    // retrying moves it and there is no document to save first.
    return ` ${nameHolders(holders)} did not let go — that is Docker's virtual machine, which holds the volume until the engine stops. Run \`bandolier eject --stop-docker\` (or \`docker desktop stop\`) and try again.`
  }
  if (holders.every((holder) => !isActionableHolder(holder.command))) {
    return ` ${nameHolders(holders)} did not let go — a system agent, so try again in a moment rather than quitting anything.`
  }
  return ` Still held by ${nameHolders(holders.filter((holder) => isActionableHolder(holder.command)))} — close it and try again.`
}

/**
 * The real device.
 *
 * `selfPid` is excluded from the holder list: `bandolier eject` is very often run
 * from a shell whose cwd is on the SSD, and this process's own cwd must not be
 * the thing that blocks the eject. The PARENT shell still counts — it is a real
 * holder and the user has to leave it.
 */
export function createSsdDevice(runner: HostRunner = execHost(), selfPid: number = process.pid): SsdDevice {
  /** One `lsof` pass, unclassified. Both holder questions are views over it. */
  const scan = async (mountPoint: string): Promise<Holder[]> => {
    const result = await runner('lsof', ['-F', 'pcLn', '--', mountPoint])
    // lsof exits 1 with no output when nothing matches — that is the answer
    // "nothing holds it", not a failure.
    if (result.code !== 0 && result.stdout.trim().length === 0) {
      if (result.code === 1 && result.stderr.trim().length === 0) return []
      throw new BandolierError(
        'EJECT_BLOCKED',
        `Could not determine what is holding ${mountPoint}: ${result.stderr.trim() || `lsof exited ${result.code}`}. Refusing to eject without knowing.`,
        { holders: [], reason: 'holder-check-failed' },
      )
    }
    return parseLsof(result.stdout, mountPoint).filter((holder) => holder.pid !== selfPid)
  }

  return {
    async holders(mountPoint) {
      return (await scan(mountPoint)).filter((holder) => isActionableHolder(holder.command))
    },

    async runtimeHolders(mountPoint) {
      return (await scan(mountPoint)).filter((holder) => isRuntimeHolder(holder.command))
    },

    async removable(mountPoint) {
      const result = await runner('diskutil', ['info', '-plist', mountPoint])
      if (result.code !== 0) return false
      const ejectable = plistBool(result.stdout, 'Ejectable')
      const internalDisk = plistBool(result.stdout, 'Internal')
      if (ejectable === null || internalDisk === null) return false
      return ejectable && !internalDisk
    },

    async eject(mountPoint) {
      const result = await runner('diskutil', ['eject', mountPoint])
      if (result.code !== 0) {
        // diskutil's own refusal — a dissenter, a busy volume — is reported as
        // it came, never retried with force. The one thing added to it is the
        // dissenting process, lifted out of the text into `holders` so the app
        // renders a NAME in the same place it renders lsof's, instead of an
        // empty list under a sentence it would have to parse itself.
        const said = result.stderr.trim() || result.stdout.trim() || `diskutil exited ${result.code}`
        const holders = parseDissenter(`${result.stdout}\n${result.stderr}`)
        throw new BandolierError(
          'EJECT_BLOCKED',
          `diskutil refused to eject ${mountPoint}: ${said}${adviseOn(holders)}`,
          { holders, reason: 'diskutil-refused' },
        )
      }
    },
  }
}
