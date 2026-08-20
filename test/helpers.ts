/**
 * Test scaffolding.
 *
 * Fakes stand in for everything outside the process: a temp directory in place
 * of the SSD, a scripted Docker, a scripted port probe, a scripted confirmation
 * prompt and a frozen clock. Together they let the whole CLI — including the
 * Phase 2 mutations — be exercised on a machine with no SSD and no daemon,
 * which is the point of the seams in `src/context.ts`.
 *
 * The Docker stub RECORDS what it was asked to do (`docker.calls`). For the
 * lifecycle commands that is the assertion that matters: `down` must never pass
 * `-v`, `up` must target the generated file, and so on.
 */

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { stringify as stringifyYaml } from 'yaml'

import type { Context, ContextOptions } from '../cli/src/context.ts'
import { createContext } from '../cli/src/context.ts'
import type { BuildRequest, ComposeTarget, Docker, DockerContainer, DockerImage } from '../cli/src/docker.ts'
import type { ProjectManifest } from '../cli/src/model/project.ts'
import type { PortProbe } from '../cli/src/ports.ts'
import type { Confirm } from '../cli/src/confirm.ts'
import { CprojError } from '../cli/src/errors.ts'

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
  const base = mkdtempSync(join(tmpdir(), 'cproj-test-'))
  const root = join(base, 'ssd', 'claude-projects')
  const home = join(base, 'home')
  const configPath = join(home, '.config', 'cproj', 'config.yml')
  mkdirSync(root, { recursive: true })
  mkdirSync(join(home, '.config', 'cproj'), { recursive: true })

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
    base_image: 'claude-web',
    created: FIXED_NOW.toISOString(),
    ...overrides,
  }
}

export type StubDockerOptions = {
  readonly available?: boolean
  /** Container names treated as running; labels/image are rarely relevant here. */
  readonly running?: readonly string[]
  readonly images?: readonly string[]
  readonly volumes?: readonly string[]
  /** Volume names `removeVolume` should reject with VOLUME_IN_USE. */
  readonly volumesInUse?: readonly string[]
  /**
   * Container names that appear once `composeUp` has been called — the stub's
   * way of modelling "the daemon did what it was told".
   */
  readonly startsAs?: readonly string[]
}

/** One recorded mutation. */
export type DockerCall =
  | { readonly kind: 'up'; readonly target: ComposeTarget }
  | { readonly kind: 'down'; readonly target: ComposeTarget }
  | { readonly kind: 'build'; readonly request: BuildRequest }
  | { readonly kind: 'removeVolume'; readonly name: string }

export type StubDocker = Docker & {
  /** Mutations in the order they were requested. */
  readonly calls: readonly DockerCall[]
}

/** A Docker that answers from a script instead of a daemon, and records mutations. */
export function stubDocker(options: StubDockerOptions = {}): StubDocker {
  const available = options.available ?? true
  const calls: DockerCall[] = []
  let running = new Set(options.running ?? [])
  const volumes = new Set(options.volumes ?? [])
  const inUse = new Set(options.volumesInUse ?? [])

  const fail = async (): Promise<never> => {
    throw new Error('stubDocker: queried while unavailable')
  }
  const requireAvailable = (what: string) => {
    if (!available) throw new CprojError('DOCKER_UNAVAILABLE', `Could not ${what}: the stub daemon is down.`)
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
    volumeNames: available ? async () => [...volumes] : fail,
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
    async removeVolume(name) {
      requireAvailable(`remove volume ${name}`)
      if (inUse.has(name)) throw new CprojError('VOLUME_IN_USE', `Volume ${name} is still in use.`)
      calls.push({ kind: 'removeVolume', name })
      volumes.delete(name)
    },
  }
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
    env: { CPROJ_SSD_ROOT: sandbox.root, ...env },
    docker,
    ports: stubPorts(),
    // Nothing in a test may block on a prompt: an unscripted question is a bug
    // in the test, not something to answer with a default.
    confirm: async (question) => {
      throw new Error(`unexpected confirmation prompt: ${question}`)
    },
    host: { uid: 501, gid: 20 },
    now: () => FIXED_NOW,
    ...rest,
  })
}
