/**
 * `cproj down <name>` — `cli-spec.md` §6 (Projects).
 *
 * Stops and removes the project's containers. DATA PERSISTS: `compose down` is
 * called without `-v`, so named volumes survive, and the bind-mounted project
 * directory is untouched. Removing data is `delete --purge` or `volumes rm`,
 * both explicit and both confirmed.
 *
 * Idempotent (§2): `down` on a stopped project is a no-op success. It still
 * runs `compose down` in that case — a project can be "stopped" by §7's rule
 * while stale exited containers or a network linger, and clearing those is what
 * makes the next `up` predictable.
 */

import { existsSync } from 'node:fs'
import type { Context } from '../context.ts'
import { composeProject } from '../naming.ts'
import { attachedKeys } from '../compose.ts'
import type { DownOutput } from '../model/lifecycle.ts'
import type { ProjectManifest } from '../model/project.ts'
import type { ServiceCatalogue } from '../model/catalogue.ts'
import { composePath, observeProject, regenerateCompose, requireProject } from '../workspace.ts'

/**
 * `compose down` needs a file describing what to remove. If it is missing — a
 * deleted file, an interrupted `new` — regenerate it from the manifest rather
 * than failing: the manifest already says exactly what should be torn down.
 */
function ensureCompose(ctx: Context, dir: string, manifest: ProjectManifest): string {
  const path = composePath(dir)
  if (!existsSync(path)) {
    const catalogue: ServiceCatalogue | null = attachedKeys(manifest).length > 0 ? ctx.catalogue().catalogue : null
    regenerateCompose(dir, manifest, catalogue)
  }
  return path
}

export async function runDown(ctx: Context, name: string | undefined): Promise<DownOutput> {
  const project = requireProject(ctx, name)
  const { manifest, dir } = project

  const before = await observeProject(ctx, manifest)
  const file = ensureCompose(ctx, dir, manifest)

  await ctx.docker.composeDown({ file, project: composeProject(manifest.name), cwd: dir })

  return {
    project: manifest.name,
    state: 'stopped',
    was_running: before.state !== 'stopped',
    data_kept: true,
  }
}

export function renderDown(output: DownOutput): string[] {
  return [
    output.was_running ? `${output.project} stopped.` : `${output.project} was already stopped.`,
    '  Data kept: named volumes and the project directory are untouched.',
  ]
}
