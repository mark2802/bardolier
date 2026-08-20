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
import { CprojError } from './errors.ts'

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
  /** Processes with files open under `mountPoint`. Empty means nothing holds it. */
  holders(mountPoint: string): Promise<readonly Holder[]>
  /** Unmount and power down the volume. Throws EJECT_BLOCKED if it will not go. */
  eject(mountPoint: string): Promise<void>
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
 * Holders the user cannot act on, and which reporting would make `eject`
 * useless.
 *
 * Docker Desktop's VM keeps directory descriptors open on every bind-mounted
 * path for as long as the file share exists — including after `down-all` has
 * stopped every container. Listing it would mean "close Docker Desktop" is the
 * standing answer to every eject, which is not what §6's holder check is for:
 * it names Xcode, the Simulator, and shells cd'd into the SSD — processes the
 * user can see and quit.
 *
 * This is not a licence to force. Everything that could be using those
 * descriptors has just been stopped, and if the volume genuinely will not go,
 * `diskutil` refuses and that refusal is reported as it came.
 */
const VIRTUALISATION_HOLDERS = ['com.docker', 'Docker', 'com.apple.Virtualization', 'vpnkit', 'qemu'] as const

/** True for a process whose open descriptors belong to the container runtime. */
export function isRuntimeHolder(command: string): boolean {
  return VIRTUALISATION_HOLDERS.some((prefix) => command.startsWith(prefix))
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
 * The real device.
 *
 * `selfPid` is excluded from the holder list: `cproj eject` is very often run
 * from a shell whose cwd is on the SSD, and this process's own cwd must not be
 * the thing that blocks the eject. The PARENT shell still counts — it is a real
 * holder and the user has to leave it.
 */
export function createSsdDevice(runner: HostRunner = execHost(), selfPid: number = process.pid): SsdDevice {
  return {
    async holders(mountPoint) {
      const result = await runner('lsof', ['-F', 'pcLn', '--', mountPoint])
      // lsof exits 1 with no output when nothing matches — that is the answer
      // "nothing holds it", not a failure.
      if (result.code !== 0 && result.stdout.trim().length === 0) {
        if (result.code === 1 && result.stderr.trim().length === 0) return []
        throw new CprojError(
          'EJECT_BLOCKED',
          `Could not determine what is holding ${mountPoint}: ${result.stderr.trim() || `lsof exited ${result.code}`}. Refusing to eject without knowing.`,
          { holders: [], reason: 'holder-check-failed' },
        )
      }
      return parseLsof(result.stdout, mountPoint).filter(
        (holder) => holder.pid !== selfPid && !isRuntimeHolder(holder.command),
      )
    },

    async eject(mountPoint) {
      const result = await runner('diskutil', ['eject', mountPoint])
      if (result.code !== 0) {
        // diskutil's own refusal — a dissenter, a busy volume — is reported as
        // it came, never retried with force.
        throw new CprojError(
          'EJECT_BLOCKED',
          `diskutil refused to eject ${mountPoint}: ${result.stderr.trim() || result.stdout.trim() || `diskutil exited ${result.code}`}`,
          { holders: [], reason: 'diskutil-refused' },
        )
      }
    },
  }
}
