/**
 * Test scaffolding: fakes for everything outside the process — a temp dir for
 * the SSD, a scripted Docker, port probe, confirm prompt, SSD device and clock.
 * Together they exercise the whole CLI, mutations included, on a machine with
 * no SSD and no daemon — the point of the seams in `src/context.ts`.
 *
 * The Docker stub RECORDS what it was asked to do (`docker.calls`); for the
 * lifecycle commands that is the assertion that matters (`down` must never pass
 * `-v`, `up` must target the generated file).
 */

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { stringify as stringifyYaml } from 'yaml'

import type { Context, ContextOptions } from '../cli/src/context.ts'
import { createContext } from '../cli/src/context.ts'
import type {
  BuildRequest,
  ComposeTarget,
  ContainerExec,
  Docker,
  DockerContainer,
  DockerImage,
  DockerVolume,
  ExecResult,
} from '../cli/src/docker.ts'
import type { Holder, SsdDevice } from '../cli/src/device.ts'
import type { ProjectManifest } from '../cli/src/model/project.ts'
import type { PortProbe } from '../cli/src/ports.ts'
import type { Confirm } from '../cli/src/confirm.ts'
import { BardolierError } from '../cli/src/errors.ts'

export type Sandbox = {
  /** Stands in for the SSD root. */
  readonly root: string
  /** Stands in for the internal disk holding ~/.config. */
  readonly home: string
  readonly configPath: string
  /** Write `$SSD_ROOT/<name>/project.yml`. Accepts invalid manifests on purpose. */
  writeProject(name: string, manifest: unknown): string
  /** Write the config file; omit to leave it absent. */
  writeConfig(config: Record<string, unknown>): void
  writeFile(relativePath: string, contents: string): string
  /** Absolute path inside a project directory. */
  path(project: string, ...rest: string[]): string
  /** Read a file under a project directory, or null when absent. */
  read(project: string, ...rest: string[]): string | null
  exists(project: string, ...rest: string[]): boolean
  cleanup(): void
}

export function makeSandbox(): Sandbox {
  const base = mkdtempSync(join(tmpdir(), 'bardolier-test-'))
  const root = join(base, 'ssd', 'claude-projects')
  const home = join(base, 'home')
  const configPath = join(home, '.config', 'bardolier', 'config.yml')
  mkdirSync(root, { recursive: true })
  mkdirSync(join(home, '.config', 'bardolier'), { recursive: true })

  return {
    root,
    home,
    configPath,
    writeProject(name, manifest) {
      const dir = join(root, name)
      mkdirSync(dir, { recursive: true })
      const path = join(dir, 'project.yml')
      writeFileSync(path, typeof manifest === 'string' ? manifest : stringifyYaml(manifest))
      return path
    },
    writeConfig(config) {
      writeFileSync(configPath, stringifyYaml(config))
    },
    writeFile(relativePath, contents) {
      const path = join(base, relativePath)
      mkdirSync(join(path, '..'), { recursive: true })
      writeFileSync(path, contents)
      return path
    },
    path(project, ...rest) {
      return join(root, project, ...rest)
    },
    read(project, ...rest) {
      try {
        return readFileSync(join(root, project, ...rest), 'utf8')
      } catch {
        return null
      }
    },
    exists(project, ...rest) {
      return existsSync(join(root, project, ...rest))
    },
    cleanup() {
      rmSync(base, { recursive: true, force: true })
    },
  }
}

export function manifest(name: string, overrides: Partial<ProjectManifest> = {}): ProjectManifest {
  return {
    name,
    archetype: 'web',
    base_image: 'bardolier-web',
    created: FIXED_NOW.toISOString(),
    ...overrides,
  }
}

/**
 * A volume in the stub. A bare string is a volume with no labels and no known
 * size — what a hand-made `docker volume create` looks like. The object form is
 * what the generated compose file produces: our labels, and a size Docker can
 * measure.
 */
export type StubVolume = {
  readonly name: string
  /** Usually `{ 'bardolier.project': 'myapp', 'bardolier.service': 'postgres' }` (§9). */
  readonly labels?: Readonly<Record<string, string>>
  /** Omitted = Docker could not measure it, which is reported as unknown. */
  readonly size_bytes?: number
}

export type StubDockerOptions = {
  readonly available?: boolean
  /** Container names treated as running; labels/image are rarely relevant here. */
  readonly running?: readonly string[]
  readonly images?: readonly string[]
  readonly volumes?: readonly (string | StubVolume)[]
  /** Volume names `removeVolume` should reject with VOLUME_IN_USE. */
  readonly volumesInUse?: readonly string[]
  /**
   * Container names that appear once `composeUp` has been called — the stub's
   * way of modelling "the daemon did what it was told".
   */
  readonly startsAs?: readonly string[]
  /**
   * What `exec` answers, keyed by nothing — one script for every call. The
   * default is a non-zero exit, which is the honest default: most tests have no
   * agent in the container, and the handoff must degrade rather than invent.
   */
  readonly exec?: (request: ContainerExec) => ExecResult
  /**
   * What stopping the Docker engine does to the rest of the world — usually
   * `() => device.setRuntimeHolders([])`, the stub's way of saying the VM let
   * go of the volume. Throw from here to model a Docker with no `desktop`
   * plugin to stop.
   */
  readonly onStopEngine?: () => void
}

/** One recorded mutation. */
export type DockerCall =
  | { readonly kind: 'up'; readonly target: ComposeTarget }
  | { readonly kind: 'down'; readonly target: ComposeTarget }
  | { readonly kind: 'build'; readonly request: BuildRequest }
  | { readonly kind: 'ensureVolume'; readonly name: string; readonly labels: Readonly<Record<string, string>> }
  | { readonly kind: 'removeVolume'; readonly name: string }
  | { readonly kind: 'removeContainer'; readonly name: string }
  | { readonly kind: 'exec'; readonly request: ContainerExec }
  | { readonly kind: 'stopEngine' }

export type StubDocker = Docker & {
  /** Mutations in the order they were requested. */
  readonly calls: readonly DockerCall[]
}

/** A Docker that answers from a script instead of a daemon, and records mutations. */
export function stubDocker(options: StubDockerOptions = {}): StubDocker {
  const available = options.available ?? true
  const calls: DockerCall[] = []
  let running = new Set(options.running ?? [])
  const volumes = new Map<string, StubVolume>()
  for (const entry of options.volumes ?? []) {
    const volume = typeof entry === 'string' ? { name: entry } : entry
    volumes.set(volume.name, volume)
  }
  const inUse = new Set(options.volumesInUse ?? [])
  const execScript =
    options.exec ?? (() => ({ code: 1, stdout: '', stderr: 'stubDocker: no exec script configured' }))

  const fail = async (): Promise<never> => {
    throw new Error('stubDocker: queried while unavailable')
  }
  const requireAvailable = (what: string) => {
    if (!available) throw new BardolierError('DOCKER_UNAVAILABLE', `Could not ${what}: the stub daemon is down.`)
  }

  return {
    calls,
    available: async () => available,
    runningContainers: available
      ? async (): Promise<readonly DockerContainer[]> =>
          [...running].map((name) => ({ names: [name], image: 'stub', state: 'running', labels: {} }))
      : fail,
    images: available
      ? async (): Promise<readonly DockerImage[]> =>
          (options.images ?? []).map((repository) => ({ repository, tag: 'latest' }))
      : fail,
    volumeNames: available ? async () => [...volumes.keys()] : fail,
    volumes: available
      ? async (): Promise<readonly DockerVolume[]> =>
          [...volumes.values()].map((volume) => ({ name: volume.name, labels: volume.labels ?? {} }))
      : fail,
    volumeSizes: available
      ? async () => {
          const sizes = new Map<string, number>()
          for (const volume of volumes.values()) {
            if (volume.size_bytes !== undefined) sizes.set(volume.name, volume.size_bytes)
          }
          return sizes
        }
      : fail,
    refresh() {},
    async composeUp(target) {
      requireAvailable(`start ${target.project}`)
      calls.push({ kind: 'up', target })
      // Model the daemon obeying: whatever the scenario says comes up, comes up.
      if (options.startsAs) running = new Set(options.startsAs)
    },
    async composeDown(target) {
      requireAvailable(`stop ${target.project}`)
      calls.push({ kind: 'down', target })
      running = new Set()
    },
    async build(request) {
      requireAvailable(`build ${request.tag}`)
      calls.push({ kind: 'build', request })
    },
    async ensureVolume(name, labels) {
      requireAvailable(`create volume ${name}`)
      calls.push({ kind: 'ensureVolume', name, labels })
      // Idempotent, like `docker volume create`: an existing volume is left as
      // it is, labels included.
      if (!volumes.has(name)) volumes.set(name, { name, labels })
    },

    async removeVolume(name) {
      requireAvailable(`remove volume ${name}`)
      if (inUse.has(name)) throw new BardolierError('VOLUME_IN_USE', `Volume ${name} is still in use.`)
      calls.push({ kind: 'removeVolume', name })
      volumes.delete(name)
    },
    async removeContainer(name) {
      requireAvailable(`remove container ${name}`)
      calls.push({ kind: 'removeContainer', name })
      running.delete(name)
    },
    async exec(request) {
      // Deliberately does NOT `requireAvailable`: the real one never throws, and
      // a stub that did would hide the fact that its caller handles everything.
      calls.push({ kind: 'exec', request })
      return execScript(request)
    },
    async stopEngine() {
      calls.push({ kind: 'stopEngine' })
      options.onStopEngine?.()
    },
  }
}

export type StubDeviceOptions = {
  /**
   * The container runtime's hold — what the real device reports from
   * `runtimeHolders()` and deliberately leaves out of `holders()`. Present
   * means `eject` is refused the way Docker Desktop's live VM refuses it.
   */
  readonly runtime?: readonly Holder[]
  /**
   * Who `diskutil` NAMES in its refusal, when that differs from who is holding
   * it — an empty array is the real and awkward case where it refuses without
   * naming anyone. Defaults to `runtime`.
   */
  readonly dissenters?: readonly Holder[]
  /**
   * Whether the stubbed volume is removable — true unless a test says
   * otherwise, so the existing eject suite (all of it about holders) keeps
   * behaving as if the volume were a real SSD (phase 10's `removable`).
   */
  readonly removable?: boolean
}

export type StubDevice = SsdDevice & {
  /** Mount points passed to `eject`, in order. Empty means it never ejected. */
  readonly ejected: string[]
  /** Change who is holding the volume — a shell opened, or quit, mid-test. */
  setHolders(holders: readonly Holder[]): void
  /** Change the runtime's hold — what stopping the Docker engine amounts to. */
  setRuntimeHolders(holders: readonly Holder[]): void
  /** Change whether the volume is removable — a local-root test going non-SSD. */
  setRemovable(removable: boolean): void
  /**
   * Let go of the volume on the `probes`th call to `runtimeHolders`, not at
   * once — the real thing after `docker desktop stop`, where the command has
   * returned but the VM helper still has the descriptors open for a few
   * seconds. `setRuntimeHolders([])` is the same event with the delay removed.
   */
  releaseRuntimeAfter(probes: number): void
  /** How many times the runtime's hold has been asked about. */
  runtimeProbes(): number
}

/** An SSD that answers a scripted holder list instead of running `lsof`. */
export function stubDevice(initial: readonly Holder[] = [], options: StubDeviceOptions = {}): StubDevice {
  let holders = [...initial]
  let runtime = [...(options.runtime ?? [])]
  let removable = options.removable ?? true
  let releaseAfter: number | null = null
  let probes = 0
  const ejected: string[] = []
  return {
    ejected,
    setHolders(next) {
      holders = [...next]
    },
    setRuntimeHolders(next) {
      runtime = [...next]
    },
    setRemovable(next) {
      removable = next
    },
    async removable() {
      return removable
    },
    releaseRuntimeAfter(next) {
      releaseAfter = next
    },
    runtimeProbes: () => probes,
    async holders() {
      return holders
    },
    async runtimeHolders() {
      probes += 1
      if (releaseAfter !== null && probes >= releaseAfter) {
        runtime = []
        releaseAfter = null
      }
      return runtime
    },
    async eject(mountPoint) {
      if (holders.length > 0) {
        // The real `diskutil` would refuse too; a stub that ejected anyway
        // would let a bug in the ordering pass unnoticed.
        throw new BardolierError('EJECT_BLOCKED', `${mountPoint} is held by ${holders.length} process(es).`)
      }
      if (runtime.length > 0) {
        // The refusal that only stopping the engine clears, shaped like the
        // real one: diskutil's words, and whoever it named (if anyone).
        const named = options.dissenters ?? runtime
        throw new BardolierError(
          'EJECT_BLOCKED',
          `diskutil refused to eject ${mountPoint}: Unmount failed.`,
          { holders: [...named], reason: 'diskutil-refused' },
        )
      }
      ejected.push(mountPoint)
    },
  }
}

/** A holder record with sensible defaults — tests usually care about one field. */
export function holder(overrides: Partial<Holder> = {}): Holder {
  return { pid: 4242, command: 'zsh', user: 'mark', paths: ['/tmp/ssd/claude-projects'], ...overrides }
}

/** A port probe that treats a named set of ports as squatted by someone else. */
export function stubPorts(taken: readonly number[] = []): PortProbe {
  const held = new Set(taken)
  return { isFree: async (port) => !held.has(port) }
}

/** A prompt with a scripted answer, plus a record of what it was asked. */
export function stubConfirm(answer: boolean): Confirm & { readonly questions: string[] } {
  const questions: string[] = []
  const confirm = async (question: string) => {
    questions.push(question)
    return answer
  }
  return Object.assign(confirm, { questions })
}

/**
 * A sleep that records instead of sleeping.
 *
 * `eject` waits for the Docker VM to release the volume, and a test that really
 * waited would pay fifteen seconds to assert an ordering. The delays are the
 * assertion: that the retry waited at all, and how many times.
 */
export function stubWait(): ((ms: number) => Promise<void>) & { readonly delays: number[] } {
  const delays: number[] = []
  const wait = async (ms: number) => {
    delays.push(ms)
  }
  return Object.assign(wait, { delays })
}

/** The clock every test sees unless it says otherwise. */
export const FIXED_NOW = new Date('2026-08-19T10:00:00.000Z')

export type ContextOverrides = Omit<ContextOptions, 'path' | 'home' | 'env' | 'docker'> & {
  readonly env?: Record<string, string>
}

/** A Context wired to the sandbox: no real SSD, no real Docker, no real $HOME. */
export function makeContext(
  sandbox: Sandbox,
  docker: Docker = stubDocker(),
  overrides: ContextOverrides = {},
): Context {
  const { env, ...rest } = overrides
  return createContext({
    path: sandbox.configPath,
    home: sandbox.home,
    env: { BDLR_SSD_ROOT: sandbox.root, ...env },
    docker,
    ports: stubPorts(),
    // Ejecting is destructive and host-wide: a test that reaches the device
    // without scripting one is a test that would have unmounted a real disk.
    device: {
      holders: async () => {
        throw new Error('unexpected holder check: pass a stubDevice() to makeContext')
      },
      runtimeHolders: async () => {
        throw new Error('unexpected holder check: pass a stubDevice() to makeContext')
      },
      eject: async () => {
        throw new Error('unexpected eject: pass a stubDevice() to makeContext')
      },
      // Unlike holders/eject this is a read-only probe `doctor` calls on every
      // run, so it answers rather than throws — true, matching the fiction the
      // whole suite maintains that the sandbox temp dir stands in for a real
      // SSD (§8). Tests of phase 10's local-root mode pass a stubDevice().
      removable: async () => true,
    },
    // Nothing in a test may block on a prompt: an unscripted question is a bug
    // in the test, not something to answer with a default.
    confirm: async (question) => {
      throw new Error(`unexpected confirmation prompt: ${question}`)
    },
    host: { uid: 501, gid: 20 },
    now: () => FIXED_NOW,
    // Nothing in a test may actually sleep; a test that wants to see the waits
    // passes its own `stubWait()`.
    wait: async () => {},
    ...rest,
  })
}
