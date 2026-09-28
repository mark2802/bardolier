/**
 * Copying a project directory into place — shared by `clone` and `move`.
 *
 * Two rules, both about what an interrupted copy leaves behind:
 *
 *   STAGED, THEN SWAPPED. Content lands in `<root>/.<name>.incoming` and is
 *   renamed to `<root>/<name>` only once it is complete. Discovery skips
 *   dot-prefixed entries (`projects.ts`), so a copy in progress is never a
 *   half-project `status` can see, and an interrupted one leaves a directory
 *   that names itself. `new` writes its manifest FIRST, deliberately — a
 *   multi-gigabyte copy inverts that reasoning.
 *
 *   SPACE FIRST. Free bytes on the target are compared with the sources' size
 *   before anything moves. Filling a disk halfway through is the failure that
 *   costs the most to undo.
 *
 * Pure Node throughout — no spawn — so nothing here joins `Context` and the
 * whole path runs against a temp dir in a unit test.
 */

import { cpSync, mkdirSync, renameSync, rmSync, statfsSync } from 'node:fs'
import { join } from 'node:path'
import { BardolierError } from './errors.ts'
import { directorySize } from './layout.ts'
import type { MoveMode } from './model/lifecycle.ts'
import { formatBytes } from './volumes.ts'

/** One directory to copy: an absolute `from`, and its name inside the staged project. */
export type CopySource = {
  readonly from: string
  readonly to: string
}

/** Where a staged copy lives until it is complete. Dot-prefixed, so discovery skips it. */
export function stagingPath(rootPath: string, name: string): string {
  return join(rootPath, `.${name}.incoming`)
}

/** Free bytes on the filesystem holding `path`. The seam a test replaces. */
export type FreeSpace = (path: string) => number

export const freeBytes: FreeSpace = (path) => {
  const stats = statfsSync(path)
  return Number(stats.bsize) * Number(stats.bavail)
}

/** Apparent bytes under every source, the number the space check is made against. */
export function sourceBytes(sources: readonly CopySource[]): number {
  return sources.reduce((total, source) => total + directorySize(source.from), 0)
}

/** Refuse before any byte moves, naming both numbers so the answer is actionable. */
export function requireSpace(targetRoot: string, needed: number, free: FreeSpace = freeBytes): void {
  const available = free(targetRoot)
  if (needed <= available) return
  throw new BardolierError(
    'INSUFFICIENT_SPACE',
    `Copying ${formatBytes(needed)} needs more room than ${targetRoot} has: ${formatBytes(available)} free.`,
    { path: targetRoot, needed_bytes: needed, free_bytes: available },
  )
}

/**
 * Copy each source into the staged directory.
 *
 * `preserveTimestamps` so a clone's files are not all newer than the work they
 * came from, and `verbatimSymlinks` so a link into `work/` is copied as the
 * link it is rather than resolved into a second copy of its target.
 */
export function copyInto(staging: string, sources: readonly CopySource[]): void {
  for (const source of sources) {
    cpSync(source.from, join(staging, source.to), {
      recursive: true,
      preserveTimestamps: true,
      verbatimSymlinks: true,
    })
  }
}

export type Staged = {
  /** The final project directory, once the swap succeeded. */
  readonly dir: string
  /** What `populate` reported having copied. */
  readonly bytes: number
}

/**
 * Build a project directory off to one side, then swap it into place.
 *
 * `populate` writes into the staging directory and returns the bytes it copied;
 * anything it throws removes the staging directory before it propagates, so a
 * failed copy leaves the root exactly as it found it.
 */
export function stageProject(
  rootPath: string,
  name: string,
  populate: (staging: string) => number,
): Staged {
  const staging = stagingPath(rootPath, name)
  // A leftover from an interrupted copy is incomplete by definition, and it is
  // ours by name — retrying must not fail on it.
  rmSync(staging, { recursive: true, force: true })
  mkdirSync(staging, { recursive: true })

  const dir = join(rootPath, name)
  try {
    const bytes = populate(staging)
    renameSync(staging, dir)
    return { dir, bytes }
  } catch (cause) {
    rmSync(staging, { recursive: true, force: true })
    throw cause
  }
}

/** Renaming a directory in place — the seam a test replaces to force `EXDEV`. */
export type Rename = (from: string, to: string) => void
export const renameDir: Rename = (from, to) => renameSync(from, to)

export type Relocated = {
  readonly dir: string
  readonly bytes: number
  readonly mode: MoveMode
}

/** Seams `move` can replace in a test — same idea as `stageProject`'s `populate`. */
export type Relocation = {
  readonly rename?: Rename
  readonly free?: FreeSpace
  readonly copy?: typeof copyInto
}

/**
 * Move `sourceDir` to `<targetRoot>/<name>`.
 *
 * `rename(2)` first: two roots on one filesystem move instantly and
 * atomically, with no window in which the project exists twice. Only `EXDEV`
 * — a genuine cross-device move — falls back to the staged copy; anything
 * else `rename` throws propagates as-is.
 *
 * The whole directory moves, not just §3's four folders: `project.yml`,
 * `docker-compose.yml`, `.bardolier/`, any stray file the user left. Nothing
 * inside is rewritten, so `to: '.'` copies the source's contents straight
 * into the staging directory `stageProject` already made.
 *
 * The source is removed LAST, after the copy is complete and in place. If
 * that removal itself fails, the copy has already landed — the move
 * succeeded and the old directory is now a leftover the caller must say so
 * about, not a reason to undo a finished copy.
 */
export function relocate(
  sourceDir: string,
  targetRoot: string,
  name: string,
  seams: Relocation = {},
): Relocated {
  const rename = seams.rename ?? renameDir
  const bytes = directorySize(sourceDir)
  const dir = join(targetRoot, name)

  try {
    rename(sourceDir, dir)
    return { dir, bytes, mode: 'rename' }
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code !== 'EXDEV') throw cause
  }

  const copy = seams.copy ?? copyInto
  requireSpace(targetRoot, bytes, seams.free)
  const staged = stageProject(targetRoot, name, (staging) => {
    copy(staging, [{ from: sourceDir, to: '.' }])
    return bytes
  })
  rmSync(sourceDir, { recursive: true, force: true })
  return { dir: staged.dir, bytes: staged.bytes, mode: 'copy' }
}
