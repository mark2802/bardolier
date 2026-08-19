/**
 * Test scaffolding for the Phase 1 read-only core.
 *
 * Two fakes stand in for the two things Phase 1 reads: a temp directory in
 * place of the SSD, and a scripted runner in place of the Docker CLI. Together
 * they let the whole layer be exercised on a machine with neither — which is
 * the point of the seams in `src/docker.ts` and `src/projects.ts`.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { stringify as stringifyYaml } from 'yaml'

import type { Context } from '../cli/src/context.ts'
import { createContext } from '../cli/src/context.ts'
import type { Docker, DockerContainer, DockerImage } from '../cli/src/docker.ts'
import type { ProjectManifest } from '../cli/src/model/project.ts'

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
    created: '2026-08-19T10:00:00Z',
    ...overrides,
  }
}

export type StubDockerOptions = {
  readonly available?: boolean
  /** Container names treated as running; labels/image are rarely relevant here. */
  readonly running?: readonly string[]
  readonly images?: readonly string[]
  readonly volumes?: readonly string[]
}

/** A Docker that answers from a script instead of a daemon. */
export function stubDocker(options: StubDockerOptions = {}): Docker {
  const available = options.available ?? true
  const fail = async (): Promise<never> => {
    throw new Error('stubDocker: queried while unavailable')
  }
  return {
    available: async () => available,
    runningContainers: available
      ? async (): Promise<readonly DockerContainer[]> =>
          (options.running ?? []).map((name) => ({ names: [name], image: 'stub', state: 'running', labels: {} }))
      : fail,
    images: available
      ? async (): Promise<readonly DockerImage[]> =>
          (options.images ?? []).map((repository) => ({ repository, tag: 'latest' }))
      : fail,
    volumeNames: available ? async () => options.volumes ?? [] : fail,
  }
}

/** A Context wired to the sandbox: no real SSD, no real Docker, no real $HOME. */
export function makeContext(sandbox: Sandbox, docker: Docker = stubDocker(), env: Record<string, string> = {}): Context {
  return createContext({
    path: sandbox.configPath,
    home: sandbox.home,
    env: { CPROJ_SSD_ROOT: sandbox.root, ...env },
    docker,
  })
}
