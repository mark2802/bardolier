/**
 * The shape of a project directory — `cli-spec.md` §3, §4.2.
 *
 * A project directory is NOT a repository. bardolier's own files sit at the top
 * (`project.yml`, `docker-compose.yml`, `.bardolier/`) and everything else lives
 * in one of four bind-mounted folders below them. Repositories are cloned into
 * `work/`, so nothing this tool writes is ever inside a working tree: there is
 * nothing to gitignore, and `git clean -xdf` cannot reach the data.
 *
 * Service data is one directory per catalogue key under `data/`, on the same
 * disk as the project — a named volume would have put it in `Docker.raw` on the
 * internal disk however external the root was.
 *
 * The directories are created BEFORE compose runs, by `new` and by every `up`.
 * Docker creates a missing bind source itself, as root, which would leave
 * `home/` unwritable by the container's own uid.
 */

import { mkdirSync, readdirSync, statSync, writeFileSync, type Dirent } from 'node:fs'
import { join } from 'node:path'

/** Host-side directory names, relative to the project directory. */
export const WORK_DIR = 'work'
export const DATA_DIR = 'data'
export const LOCAL_DIR = 'local'
export const HOME_DIR = 'home'

/** The four, in the order `new` reports them. */
export const PROJECT_DIRS = [WORK_DIR, DATA_DIR, LOCAL_DIR, HOME_DIR] as const

/** Where each one is mounted inside the dev container (`CONTAINER_HOME` is in `images.ts`). */
export const CONTAINER_WORK = '/work'
export const CONTAINER_DATA = '/data'
export const CONTAINER_LOCAL = '/local'

/**
 * Spotlight's opt-out marker, written into `data/` at creation.
 *
 * Indexing a multi-GB database directory is wasted effort, and it puts `mds` on
 * the volume — the holder `eject` already has to filter as non-actionable
 * (`device.ts`). Cheaper to prevent than to work around.
 */
export const NEVER_INDEX = '.metadata_never_index'

export function workDir(dir: string): string {
  return join(dir, WORK_DIR)
}

export function dataDir(dir: string): string {
  return join(dir, DATA_DIR)
}

export function homeDir(dir: string): string {
  return join(dir, HOME_DIR)
}

/** One service's data directory. The catalogue KEY is the name — §4.1 has no `volume`. */
export function serviceDataDir(dir: string, key: string): string {
  return join(dir, DATA_DIR, key)
}

/**
 * Create every bind source if it is missing, plus the Spotlight marker: the
 * four folders, and one `data/<key>` per attached service.
 *
 * Idempotent, and called on every `up` as well as at `new`, so a hand-deleted
 * `home/` heals. Leaving a source for Docker to create is not an option in
 * either direction: it makes it as root, which leaves `home/` unwritable by
 * the container's own uid — and on Docker Desktop it makes it inside the VM,
 * so a service's data never reaches the disk the project is on at all.
 */
export function ensureProjectDirs(dir: string, serviceKeys: readonly string[] = []): void {
  for (const name of PROJECT_DIRS) mkdirSync(join(dir, name), { recursive: true })
  for (const key of serviceKeys) mkdirSync(serviceDataDir(dir, key), { recursive: true })
  const marker = join(dir, DATA_DIR, NEVER_INDEX)
  try {
    writeFileSync(marker, '', { flag: 'wx' })
  } catch {
    // Already there, which is the whole point of the flag.
  }
}

/** Directory entry names, or an empty list when the directory is absent. */
export function entries(path: string): string[] {
  try {
    return readdirSync(path)
  } catch {
    return []
  }
}

/** Names of the SUBDIRECTORIES of `path`, sorted; empty when it is absent. */
export function subdirectories(path: string): string[] {
  try {
    return readdirSync(path, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort()
  } catch {
    return []
  }
}

/**
 * Bytes under `path`, following no symlinks and counting apparent sizes.
 *
 * Good enough for the two questions that ask: how much a reclaimable data
 * directory would free, and whether `delete` is about to destroy something.
 * Unreadable entries count as zero rather than failing the walk — a size that
 * under-reports is a worse answer than an exact one, but a refusal to answer
 * would be worse than both.
 */
export function directorySize(path: string): number {
  let total = 0
  const stack: string[] = [path]
  while (stack.length > 0) {
    const current = stack.pop()
    if (current === undefined) continue
    let listing: Dirent[]
    try {
      listing = readdirSync(current, { withFileTypes: true })
    } catch {
      continue
    }
    for (const entry of listing) {
      const child = join(current, entry.name)
      if (entry.isDirectory()) {
        stack.push(child)
        continue
      }
      if (!entry.isFile()) continue
      try {
        total += statSync(child).size
      } catch {
        // Vanished mid-walk, or unreadable. Counts as nothing.
      }
    }
  }
  return total
}

/**
 * What `delete` would destroy: the bytes under `data/` and `home/`.
 *
 * `work/` is deliberately not counted — a clone is recoverable from its remote,
 * and counting it would make every project look like it held data. These two
 * are the directories nothing else has a copy of.
 */
export function irreplaceableBytes(dir: string): number {
  return directorySize(dataDir(dir)) + directorySize(homeDir(dir))
}

/** True when any FILE lives under `path`, ignoring one name at its top level. */
function containsFile(path: string, ignore?: string): boolean {
  const stack = [path]
  let top = true
  while (stack.length > 0) {
    const current = stack.pop()
    if (current === undefined) continue
    let listing: Dirent[]
    try {
      listing = readdirSync(current, { withFileTypes: true })
    } catch {
      continue
    }
    for (const entry of listing) {
      if (top && entry.name === ignore) continue
      if (entry.isDirectory()) stack.push(join(current, entry.name))
      else return true
    }
    top = false
  }
  return false
}

/**
 * True when `data/` or `home/` holds anything of the user's — what makes a
 * plain `delete` refuse (§6, PROJECT_HAS_DATA).
 *
 * FILES, not directories: `new` and `up` create the bind sources themselves
 * (see above), so an empty `data/postgres` is bardolier's own scaffolding and
 * refusing over it would make an untouched project undeletable. The Spotlight
 * marker is ours for the same reason.
 */
export function holdsData(dir: string): boolean {
  return containsFile(dataDir(dir), NEVER_INDEX) || containsFile(homeDir(dir))
}
