/**
 * `cproj delete <name> [--force] [--keep-data | --purge]` — `cli-spec.md` §6.
 *
 * The most destructive command in the CLI, so it is the most conservative one:
 *
 *   - It confirms unless `--force`, and refuses to guess when there is no
 *     terminal to ask (see `confirm.ts`).
 *   - `--keep-data` is the DEFAULT: named volumes survive and become listed
 *     orphans, reclaimable later through `volumes rm`. `--purge` is the only
 *     path that destroys them, and it says so in the prompt.
 *   - Containers come down first. Removing the directory out from under running
 *     containers would leave them alive with a vanished bind mount.
 *
 * Deleting the directory releases the project's host ports implicitly: §5 scans
 * manifests, so a manifest that no longer exists holds nothing.
 */

import { rmSync } from 'node:fs'
import type { Context } from '../context.ts'
import { CprojError } from '../errors.ts'
import { attachedKeys, projectVolumes } from '../compose.ts'
import type { DeleteOutput } from '../model/lifecycle.ts'
import type { ProjectManifest } from '../model/project.ts'
import { requireProject } from '../workspace.ts'
import { runDown } from './down.ts'

export type DeleteRequest = {
  readonly name: string | undefined
  readonly force: boolean
  readonly keepData: boolean
  readonly purge: boolean
  /** True under `--json`, where there is no way to ask a question (§2). */
  readonly json: boolean
}

function assignedPorts(manifest: ProjectManifest): number[] {
  return attachedKeys(manifest)
    .map((key) => manifest.services?.[key]?.host_port)
    .filter((port): port is number => typeof port === 'number')
    .sort((a, b) => a - b)
}

export async function runDelete(ctx: Context, request: DeleteRequest): Promise<DeleteOutput> {
  if (request.keepData && request.purge) {
    throw new CprojError('INVALID_ARGUMENT', '`--keep-data` and `--purge` contradict each other; pass at most one.')
  }
  const project = requireProject(ctx, request.name)
  const { manifest, dir } = project

  // Volume names come from the catalogue, so a broken catalogue must not block
  // deleting the directory — only `--purge` genuinely needs them.
  let volumes: string[] = []
  if (attachedKeys(manifest).length > 0) {
    try {
      volumes = projectVolumes(manifest, ctx.catalogue().catalogue)
    } catch (cause) {
      if (request.purge) throw cause
    }
  }

  const ports = assignedPorts(manifest)

  if (!request.force) {
    if (request.json) {
      // A prompt on stdout would break the §2 single-JSON-value guarantee, and
      // the app does its own confirmation before calling with --force.
      throw new CprojError(
        'INVALID_ARGUMENT',
        `Refusing to delete \`${manifest.name}\` without confirmation. Under --json, pass --force.`,
      )
    }
    const fate = request.purge
      ? `Delete ${dir} AND destroy ${volumes.length} named volume(s): ${volumes.join(', ') || 'none'}?`
      : `Delete ${dir}? Named volumes are kept${volumes.length > 0 ? ` (${volumes.join(', ')})` : ''}.`
    const confirmed = await ctx.confirm(fate)
    if (!confirmed) {
      return {
        project: manifest.name,
        deleted: false,
        dir,
        released_ports: [],
        removed_volumes: [],
        kept_volumes: volumes,
      }
    }
  }

  await runDown(ctx, manifest.name)

  const removed: string[] = []
  if (request.purge) {
    for (const volume of volumes) {
      await ctx.docker.removeVolume(volume)
      removed.push(volume)
    }
  }

  rmSync(dir, { recursive: true, force: true })

  return {
    project: manifest.name,
    deleted: true,
    dir,
    released_ports: ports,
    removed_volumes: removed,
    kept_volumes: request.purge ? [] : volumes,
  }
}

export function renderDelete(output: DeleteOutput): string[] {
  if (!output.deleted) return [`Left ${output.project} alone.`]

  const lines = [`Deleted ${output.project} (${output.dir}).`]
  if (output.released_ports.length > 0) lines.push(`  released ports: ${output.released_ports.join(', ')}`)
  if (output.removed_volumes.length > 0) lines.push(`  removed volumes: ${output.removed_volumes.join(', ')}`)
  if (output.kept_volumes.length > 0) {
    lines.push(`  kept volumes:   ${output.kept_volumes.join(', ')}`)
    lines.push('  They are now orphans — reclaim with `cproj volumes orphaned`.')
  }
  return lines
}
