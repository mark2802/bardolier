/**
 * The seam between commands and the outside world.
 *
 * A command never reaches for `process.env`, the filesystem root, the clock, or
 * `docker` directly — it takes a Context. Production builds one from the real
 * config and real runners; tests build one pointing at a temp dir with stubs,
 * which is how the whole lifecycle is verifiable on a machine with no SSD and
 * no Docker daemon.
 *
 * Phase 2 widens it from "what we read" to "what we do": mutating Docker calls,
 * a host-port probe, a confirmation prompt, and a clock. Phase 4 adds the last
 * of it — the SSD device, which is how `eject` asks `lsof` who is holding the
 * volume and tells `diskutil` to unmount it. Everything with an observable side
 * effect belongs here, or the tests stop being honest.
 */

import type { Config, LoadOptions, LoadedConfig } from './config.ts'
import { loadConfig } from './config.ts'
import type { Docker } from './docker.ts'
import { createDocker } from './docker.ts'
import type { ResolvedCatalogue } from './catalogue.ts'
import { resolveCatalogue } from './catalogue.ts'
import type { PortProbe } from './ports.ts'
import { createPortProbe } from './ports.ts'
import type { Confirm } from './confirm.ts'
import { createConfirm } from './confirm.ts'
import type { SsdDevice } from './device.ts'
import { createSsdDevice } from './device.ts'
import type { Git } from './git.ts'
import { createGit } from './git.ts'

/** Ownership the dev container's files must match — build args at image build. */
export type HostIdentity = {
  readonly uid: number
  readonly gid: number
}

export type Context = {
  readonly loaded: LoadedConfig
  readonly config: Config
  readonly docker: Docker
  /** Deferred: `doctor` must be able to REPORT a broken catalogue, not die of one. */
  readonly catalogue: () => ResolvedCatalogue
  readonly ports: PortProbe
  /** `lsof` + `diskutil` behind one seam — everything `eject` does to the host. */
  readonly device: SsdDevice
  readonly confirm: Confirm
  /** Host `git` behind the seam: who the human is, and what a project did (§12). */
  readonly git: Git
  readonly host: HostIdentity
  /** The clock, injected so `new`'s `created` timestamp is assertable. */
  readonly now: () => Date
  /**
   * Sleep, injected for the same reason as the clock.
   *
   * `eject` has one thing worth waiting for — the Docker VM letting go of the
   * volume after the engine stops — and a test that really slept for it would
   * pay fifteen seconds to assert an ordering. Passing time is an observable
   * side effect, so it belongs on the seam like every other.
   */
  readonly wait: (ms: number) => Promise<void>
}

export type ContextOptions = LoadOptions & {
  readonly docker?: Docker
  readonly ports?: PortProbe
  readonly device?: SsdDevice
  readonly confirm?: Confirm
  readonly git?: Git
  readonly host?: HostIdentity
  readonly now?: () => Date
  readonly wait?: (ms: number) => Promise<void>
}

/** `process.getuid` is undefined on Windows; the fallback keeps types honest. */
function hostIdentity(): HostIdentity {
  return {
    uid: typeof process.getuid === 'function' ? process.getuid() : 0,
    gid: typeof process.getgid === 'function' ? process.getgid() : 0,
  }
}

export function createContext(options: ContextOptions = {}): Context {
  const { docker, ports, device, confirm, git, host, now, wait, ...loadOptions } = options
  const loaded = loadConfig(loadOptions)
  let resolved: ResolvedCatalogue | null = null

  return {
    loaded,
    config: loaded.config,
    docker: docker ?? createDocker(),
    catalogue: () => {
      resolved ??= resolveCatalogue(loaded.config)
      return resolved
    },
    ports: ports ?? createPortProbe(),
    device: device ?? createSsdDevice(),
    confirm: confirm ?? createConfirm(),
    git: git ?? createGit(),
    host: host ?? hostIdentity(),
    now: now ?? (() => new Date()),
    wait: wait ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms))),
  }
}
