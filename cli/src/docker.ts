/**
 * Read-only Docker probe.
 *
 * Phase 1 only ever asks Docker questions — no `run`, `rm`, or `compose`. Every
 * process failure is mapped to DOCKER_UNAVAILABLE here so no raw stderr or
 * spawn error escapes into a command (cli-spec.md §2).
 *
 * The `DockerRunner` seam is the whole point of this module: tests substitute a
 * runner and exercise `status`/`doctor` on a machine with no Docker daemon and
 * no SSD. Nothing above this file may spawn `docker` itself.
 *
 * Results are memoised per instance. One CLI invocation = one snapshot, so a
 * project can't be reported half-running because containers changed mid-render.
 */

import { execFile } from 'node:child_process'
import { CprojError } from './errors.ts'

export type ExecResult = {
  readonly code: number
  readonly stdout: string
  readonly stderr: string
}

export type DockerRunner = (args: readonly string[]) => Promise<ExecResult>

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

export type Docker = {
  /** Is the daemon reachable? Never throws — callers report, not fail. */
  available(): Promise<boolean>
  /** Currently running containers. Throws DOCKER_UNAVAILABLE if the daemon is down. */
  runningContainers(): Promise<readonly DockerContainer[]>
  volumeNames(): Promise<readonly string[]>
  images(): Promise<readonly DockerImage[]>
}

const DEFAULT_TIMEOUT_MS = 10_000

/** Spawns the real `docker` binary. Replaced wholesale in tests. */
export function execDocker(timeoutMs = DEFAULT_TIMEOUT_MS): DockerRunner {
  return (args) =>
    new Promise((resolveResult) => {
      execFile('docker', [...args], { timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024 }, (error, stdout, stderr) => {
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
  const ok = async (args: readonly string[], what: string): Promise<ExecResult> => {
    const result = await runner(args)
    if (result.code !== 0) {
      throw new CprojError('DOCKER_UNAVAILABLE', `Could not ${what}: ${result.stderr.trim() || `docker exited ${result.code}`}`)
    }
    return result
  }

  const available = memoise(async () => {
    const result = await runner(['version', '--format', '{{.Server.Version}}'])
    return result.code === 0
  })

  const runningContainers = memoise(async () => {
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
  })

  const volumeNames = memoise(async () => {
    const result = await ok(['volume', 'ls', '--format', '{{.Name}}'], 'list volumes')
    return result.stdout
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.length > 0)
  })

  const images = memoise(async () => {
    const result = await ok(['images', '--format', '{{json .}}'], 'list images')
    return parseJsonLines(result.stdout).map((row): DockerImage => ({
      repository: str(row, 'Repository'),
      tag: str(row, 'Tag'),
    }))
  })

  return { available, runningContainers, volumeNames, images }
}
