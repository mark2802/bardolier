/**
 * `bardolier move <name> --root <target>` — `cli-spec.md` §6 (Projects), phase 21.
 *
 * A project changes disks without changing anything about itself. Every bind
 * in the compose file is relative to the compose file's own directory (§9),
 * and the manifest names no path — a project is byte-identical wherever it
 * sits, and its ports never move (invariant 4 holds by doing nothing at all).
 *
 * What `mv` lacks is the three refusals: that the containers are down, that
 * the bytes will fit, and that the source is not removed until the copy is
 * complete. `relocate` (`transfer.ts`) is the mechanism; this module is the
 * command-shaped wrapper around it — argument checks, the idempotent no-op,
 * and the PROJECT_RUNNING guard.
 *
 * The no-op (`--root` already the project's own) returns before any Docker
 * query: a move that touches nothing cannot tear anything, so it succeeds
 * even against a project that happens to be running.
 */

import { existsSync } from 'node:fs'
import { join } from 'node:path'
import type { Context } from '../context.ts'
import { BardolierError } from '../errors.ts'
import type { MoveOutput } from '../model/lifecycle.ts'
import { findRoot } from '../projects.ts'
import { removeFromRootIndex, upsertRootIndex } from '../rootindex.ts'
import { requireProject } from '../workspace.ts'
import { relocate } from '../transfer.ts'
import { formatBytes } from '../volumes.ts'
import { requireRoot } from './new.ts'
import { requireStopped } from './service.ts'

export type MoveRequest = {
  readonly name: string | undefined
  readonly root: string | undefined
}

export async function runMove(ctx: Context, request: MoveRequest): Promise<MoveOutput> {
  const project = requireProject(ctx, request.name)

  if (!request.root) throw new BardolierError('INVALID_ARGUMENT', 'Usage: bardolier move <name> --root <target>')

  const sourceRoot = findRoot(ctx.config, project.root)
  if (!sourceRoot) throw new BardolierError('INTERNAL_ERROR', `\`${project.name}\` was found under an unconfigured root.`)
  const target = requireRoot(ctx, request.root, sourceRoot, "there is nowhere to move it")

  // Naming the root the project is already in is a no-op success (§2), and
  // one that must not need a live daemon: nothing about the project changes.
  if (target.name === project.root) {
    return {
      project: project.name,
      moved: false,
      from: { root: project.root, dir: project.dir },
      to: { root: project.root, dir: project.dir },
      bytes: 0,
      mode: 'rename',
    }
  }

  const dir = join(target.path, project.name)
  if (existsSync(dir)) throw new BardolierError('PROJECT_EXISTS', `\`${project.name}\` already exists at ${dir}.`)

  // Moving the bind sources out from under live containers leaves them
  // running against a directory that no longer exists (§2, no partial
  // mutation of running state).
  await requireStopped(ctx, project, 'moving it')

  const result = relocate(project.dir, target.path, project.name)

  // Write-through (§5, phase 27): the project's ports and name are unchanged,
  // but which root holds them is — an offline source or target must not go on
  // reporting (or fail to report) this project under the wrong one.
  if (sourceRoot) removeFromRootIndex(ctx, sourceRoot, project.name)
  upsertRootIndex(ctx, target, project.manifest)

  return {
    project: project.name,
    moved: true,
    from: { root: project.root, dir: project.dir },
    to: { root: target.name, dir: result.dir },
    bytes: result.bytes,
    mode: result.mode,
  }
}

export function renderMove(output: MoveOutput): string[] {
  if (!output.moved) return [`Left ${output.project} on ${output.to.root} — already there.`]

  const how = output.mode === 'rename' ? 'instant — same filesystem, nothing copied' : 'copied, then removed the original'
  return [
    `Moved ${output.project} (${formatBytes(output.bytes)}) from ${output.from.root} → ${output.to.root}.`,
    `  ${output.from.dir} → ${output.to.dir}`,
    `  ${how}`,
    `  ports unchanged — bardolier up ${output.project} starts it exactly as before`,
  ]
}
