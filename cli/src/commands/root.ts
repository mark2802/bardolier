/**
 * `bardolier root add | remove | list` — cli-spec.md §6 (Roots), phase 18.
 *
 * A list-valued config key cannot go through `config set` (§8), so `roots`
 * gets its own command surface — the same reasoning phase 6 gave `catalogue`
 * and `config get|set`. `root remove` never touches the directory or anything
 * in it: forgetting a location is not deleting one.
 */

import type { Context } from '../context.ts'
import { addRootToFile, currentRoots, expandPath, isValidRootName, nameFromPath, removeRootFromFile, type RootConfig } from '../config.ts'
import { BardolierError } from '../errors.ts'
import { probeRoot } from '../projects.ts'
import type { RootAddOutput, RootListOutput, RootRemoveOutput, RootRow } from '../model/root.ts'

function toRow(root: RootConfig): RootRow {
  return { name: root.name, path: root.path, mounted: probeRoot(root).mounted }
}

export type RootAddRequest = {
  readonly path: string | undefined
  readonly name: string | undefined
}

export function runRootAdd(ctx: Context, request: RootAddRequest): RootAddOutput {
  if (!request.path) throw new BardolierError('INVALID_ARGUMENT', 'Usage: bardolier root add <path> [--name <name>]')
  const path = expandPath(request.path, ctx.loaded.home)
  const name = request.name ?? nameFromPath(path)
  if (!isValidRootName(name)) {
    throw new BardolierError(
      'INVALID_ARGUMENT',
      `\`${name}\` is not a usable root name: use letters, digits, dot, dash or underscore, starting with a letter or digit.`,
    )
  }

  const write = addRootToFile(ctx.loaded.path, { name, path }, ctx.loaded.home)
  const roots = currentRoots(ctx.loaded.path, ctx.loaded.home)
  return { path: write.path, created: write.created, added: toRow({ name, path }), roots: roots.map(toRow) }
}

export type RootRemoveRequest = {
  readonly name: string | undefined
}

export function runRootRemove(ctx: Context, request: RootRemoveRequest): RootRemoveOutput {
  if (!request.name) throw new BardolierError('INVALID_ARGUMENT', 'Usage: bardolier root remove <name>')
  const { path, removed } = removeRootFromFile(ctx.loaded.path, request.name, ctx.loaded.home)
  const roots = currentRoots(path, ctx.loaded.home)
  return { path, removed: toRow(removed), roots: roots.map(toRow) }
}

export function collectRootList(ctx: Context): RootListOutput {
  return { roots: ctx.config.roots.map(toRow) }
}

function renderRoots(roots: readonly RootRow[]): string[] {
  if (roots.length === 0) return ['No roots configured.']
  const width = Math.max(...roots.map((r) => r.name.length))
  return roots.map(
    (root, index) =>
      `${index === 0 ? '*' : ' '} ${root.name.padEnd(width)}  ${root.mounted ? 'mounted   ' : 'unreadable'}  ${root.path}`,
  )
}

export function renderRootAdd(output: RootAddOutput): string[] {
  return [`Added root \`${output.added.name}\` at ${output.added.path}.`, '', ...renderRoots(output.roots)]
}

export function renderRootRemove(output: RootRemoveOutput): string[] {
  return [
    `Forgot root \`${output.removed.name}\` (${output.removed.path}). The directory itself was not touched.`,
    '',
    ...renderRoots(output.roots),
  ]
}

export function renderRootList(output: RootListOutput): string[] {
  return renderRoots(output.roots)
}
