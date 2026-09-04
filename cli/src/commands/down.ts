/**
 * `bandolier down <name>` — `cli-spec.md` §6 (Projects).
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
import { writeHandoff } from '../handoff.ts'

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

export type DownOptions = {
  /**
   * Skip the handoff note (§12). `delete` passes it — there is no point
   * summarising a project a second before its directory is removed — and
   * `--no-handoff` is how a human passes it.
   */
  readonly noHandoff?: boolean
}

export async function runDown(
  ctx: Context,
  name: string | undefined,
  options: DownOptions = {},
): Promise<DownOutput> {
  const project = requireProject(ctx, name)
  const { manifest, dir } = project

  const before = await observeProject(ctx, manifest)
  const file = ensureCompose(ctx, dir, manifest)

  // BEFORE the containers go: the agent's session lives in the dev container,
  // and one `compose down` later there is nothing left to ask (§12). Failure
  // here is never fatal — `writeHandoff` returns null rather than throwing.
  const handoff = options.noHandoff
    ? null
    : await writeHandoff(ctx, { manifest, dir, devRunning: before.devRunning })

  await ctx.docker.composeDown({ file, project: composeProject(manifest.name), cwd: dir })

  return {
    project: manifest.name,
    state: 'stopped',
    was_running: before.state !== 'stopped',
    data_kept: true,
    handoff_path: handoff?.path ?? null,
    handoff_summarised: handoff?.summarised ?? false,
  }
}

export function renderDown(output: DownOutput): string[] {
  const lines = [
    output.was_running ? `${output.project} stopped.` : `${output.project} was already stopped.`,
    '  Data kept: named volumes and the project directory are untouched.',
  ]
  if (output.handoff_path) {
    lines.push(
      output.handoff_summarised
        ? `  Handoff written (with Claude's summary): ${output.handoff_path}`
        : `  Handoff written (repository state only): ${output.handoff_path}`,
    )
  }
  return lines
}
