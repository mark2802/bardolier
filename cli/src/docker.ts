/**
 * The Docker seam — every `docker` invocation this tool makes goes through here.
 *
 * Phase 1 only asked questions. Phase 2 adds the mutations the lifecycle needs —
 * `compose up`, `compose down`, `build`, `volume rm` — and nothing else. Every
 * process failure is mapped to DOCKER_UNAVAILABLE here so no raw stderr or
 * spawn error escapes into a command (cli-spec.md §2).
 *
 * The `DockerRunner` seam is the whole point of this module: tests substitute a
 * runner and exercise the lifecycle on a machine with no Docker daemon and no
 * SSD. Nothing above this file may spawn `docker` itself.
 *
 * QUERIES are memoised per instance: one CLI invocation = one snapshot, so a
 * project can't be reported half-running because containers changed mid-render.
 * MUTATIONS are never memoised, and each one invalidates that snapshot via
 * `refresh()` — `up` has to be able to see the world it just changed.
 */

import { execFile } from 'node:child_process'
import { CprojError } from './errors.ts'

export type ExecResult = {
  readonly code: number
  readonly stdout: string
  readonly stderr: string
}

export type RunOptions = {
  /** Per-call override; a build needs far longer than a `docker ps`. */
  readonly timeoutMs?: number
}

export type DockerRunner = (args: readonly string[], options?: RunOptions) => Promise<ExecResult>

export type DockerContainer = {
  /** Every name the container answers to (`docker ps` reports these comma-joined). */
  readonly names: readonly string[]
  readonly image: string
  /** `running`, `exited`, `created`, … as reported by Docker. */
  readonly state: string
  readonly labels: Readonly<Record<string, string>>
}

export type DockerImage = {
  readonly repository: string
  readonly tag: string
}

export type ComposeTarget = {
  /** Absolute path to the generated compose file. */
  readonly file: string
  /** Compose project name (`cproj-<name>`), which namespaces the network. */
  readonly project: string
  /** Directory the compose file lives in — relative bind mounts resolve here. */
  readonly cwd: string
}

export type BuildRequest = {
  /** Image name, e.g. `claude-web`. Tagged `:latest`. */
  readonly tag: string
  /** Absolute path to the build context directory. */
  readonly context: string
  /** Absolute path to the Dockerfile. */
  readonly dockerfile: string
  /** `--build-arg` pairs; the host UID/GID live here (implementation plan, Phase 2). */
  readonly args: Readonly<Record<string, string>>
}

export type Docker = {
  /** Is the daemon reachable? Never throws — callers report, not fail. */
  available(): Promise<boolean>
  /** Currently running containers. Throws DOCKER_UNAVAILABLE if the daemon is down. */
  runningContainers(): Promise<readonly DockerContainer[]>
  volumeNames(): Promise<readonly string[]>
  images(): Promise<readonly DockerImage[]>
  /** Drop the memoised snapshot after a mutation. */
  refresh(): void
  /** `docker compose up -d`. Idempotent by Compose's own semantics (§2). */
  composeUp(target: ComposeTarget): Promise<void>
  /**
   * `docker compose down`. NEVER passes `-v`: `down` keeps data (§6). Volume
   * removal is `delete --purge` and `volumes rm`, both explicit.
   */
  composeDown(target: ComposeTarget): Promise<void>
  /** `docker build` with host UID/GID build args. */
  build(request: BuildRequest): Promise<void>
  /** Remove one named volume. Throws VOLUME_IN_USE when a container holds it. */
  removeVolume(name: string): Promise<void>
}

const DEFAULT_TIMEOUT_MS = 10_000
/** Builds and `compose up` pull layers; the query timeout is far too short. */
const MUTATION_TIMEOUT_MS = 30 * 60_000

/** Spawns the real `docker` binary. Replaced wholesale in tests. */
export function execDocker(defaultTimeoutMs = DEFAULT_TIMEOUT_MS): DockerRunner {
  return (args, options) =>
    new Promise((resolveResult) => {
      const timeout = options?.timeoutMs ?? defaultTimeoutMs
      execFile('docker', [...args], { timeout, maxBuffer: 16 * 1024 * 1024 }, (error, stdout, stderr) => {
        if (error) {
          // ENOENT (no docker binary) and a non-zero exit are the same thing to
          // us: the question could not be answered.
          const code = typeof error.code === 'number' ? error.code : 1
          resolveResult({ code, stdout: stdout ?? '', stderr: stderr || error.message })
          return
        }
        resolveResult({ code: 0, stdout: stdout ?? '', stderr: stderr ?? '' })
      })
    })
}

/** `docker ... --format '{{json .}}'` emits one JSON object per line. */
function parseJsonLines(stdout: string): Record<string, unknown>[] {
  const rows: Record<string, unknown>[] = []
  for (const line of stdout.split('\n')) {
    const trimmed = line.trim()
    if (trimmed.length === 0) continue
    try {
      const value = JSON.parse(trimmed) as unknown
      if (value && typeof value === 'object') rows.push(value as Record<string, unknown>)
    } catch {
      // A line we can't parse is a Docker output change, not a fatal error;
      // skipping it degrades detail rather than failing the whole command.
    }
  }
  return rows
}

function str(row: Record<string, unknown>, key: string): string {
  const value = row[key]
  return typeof value === 'string' ? value : ''
}

/** `docker ps` renders labels as `k=v,k2=v2`. */
function parseLabels(raw: string): Record<string, string> {
  const labels: Record<string, string> = {}
  for (const pair of raw.split(',')) {
    if (pair.length === 0) continue
    const eq = pair.indexOf('=')
    if (eq === -1) continue
    labels[pair.slice(0, eq)] = pair.slice(eq + 1)
  }
  return labels
}

function memoise<T>(fn: () => Promise<T>): () => Promise<T> {
  let pending: Promise<T> | null = null
  return () => {
    pending ??= fn()
    return pending
  }
}

export function createDocker(runner: DockerRunner = execDocker()): Docker {
  const ok = async (args: readonly string[], what: string, timeoutMs?: number): Promise<ExecResult> => {
    const result = await runner(args, timeoutMs === undefined ? undefined : { timeoutMs })
    if (result.code !== 0) {
      throw new CprojError('DOCKER_UNAVAILABLE', `Could not ${what}: ${result.stderr.trim() || `docker exited ${result.code}`}`)
    }
    return result
  }

  const available = memoise(async () => {
    const result = await runner(['version', '--format', '{{.Server.Version}}'])
    return result.code === 0
  })

  const readRunningContainers = async () => {
    const result = await ok(['ps', '--no-trunc', '--format', '{{json .}}'], 'list running containers')
    return parseJsonLines(result.stdout).map((row): DockerContainer => ({
      names: str(row, 'Names')
        .split(',')
        .map((n) => n.trim())
        .filter((n) => n.length > 0),
      image: str(row, 'Image'),
      state: str(row, 'State') || 'running',
      labels: parseLabels(str(row, 'Labels')),
    }))
  }
  let runningContainers = memoise(readRunningContainers)

  const readVolumeNames = async () => {
    const result = await ok(['volume', 'ls', '--format', '{{.Name}}'], 'list volumes')
    return result.stdout
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.length > 0)
  }
  let volumeNames = memoise(readVolumeNames)

  const readImages = async () => {
    const result = await ok(['images', '--format', '{{json .}}'], 'list images')
    return parseJsonLines(result.stdout).map((row): DockerImage => ({
      repository: str(row, 'Repository'),
      tag: str(row, 'Tag'),
    }))
  }
  let images = memoise(readImages)

  const compose = (target: ComposeTarget, args: readonly string[], what: string) =>
    ok(['compose', '--file', target.file, '--project-name', target.project, ...args], what, MUTATION_TIMEOUT_MS)

  const docker: Docker = {
    available,
    runningContainers: () => runningContainers(),
    volumeNames: () => volumeNames(),
    images: () => images(),

    refresh() {
      runningContainers = memoise(readRunningContainers)
      volumeNames = memoise(readVolumeNames)
      images = memoise(readImages)
    },

    async composeUp(target) {
      // `--remove-orphans` is what makes a regenerated compose file authoritative:
      // a container for a service that has since been detached is cleared out
      // rather than left running against a manifest that no longer lists it.
      await compose(target, ['up', '--detach', '--remove-orphans'], `start ${target.project}`)
      docker.refresh()
    },

    async composeDown(target) {
      await compose(target, ['down', '--remove-orphans'], `stop ${target.project}`)
      docker.refresh()
    },

    async build(request) {
      const args: string[] = ['build', '--tag', `${request.tag}:latest`, '--file', request.dockerfile]
      // Sorted so the same build twice is the same argv — one less reason for a
      // rebuild to differ from the build it is meant to reproduce.
      for (const key of Object.keys(request.args).sort()) {
        args.push('--build-arg', `${key}=${request.args[key]}`)
      }
      args.push(request.context)
      await ok(args, `build ${request.tag}`, MUTATION_TIMEOUT_MS)
      docker.refresh()
    },

    async removeVolume(name) {
      const result = await runner(['volume', 'rm', name])
      if (result.code !== 0) {
        const stderr = result.stderr.trim()
        // Docker's own words for "a container still references this".
        if (/in use|is being used/i.test(stderr)) {
          throw new CprojError('VOLUME_IN_USE', `Volume ${name} is still in use: ${stderr}`)
        }
        throw new CprojError(
          'DOCKER_UNAVAILABLE',
          `Could not remove volume ${name}: ${stderr || `docker exited ${result.code}`}`,
        )
      }
      docker.refresh()
    },
  }

  return docker
}
