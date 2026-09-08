/**
 * `bardolier delete <name> [--force] [--purge]` — `cli-spec.md` §6.
 *
 * The most destructive command in the CLI, so it is the most conservative one:
 *
 *   - It confirms unless `--force`, and refuses to guess when there is no
 *     terminal to ask (see `confirm.ts`).
 *   - A project holding data refuses outright. Since phase 19 the service data
 *     and the container's `$HOME` are INSIDE the directory, so "remove the
 *     directory but keep the data" cannot mean anything — there is no
 *     `--keep-data` to ask for it. A plain `delete` therefore fails
 *     PROJECT_HAS_DATA, naming what it would destroy and how big it is, and
 *     `--purge` is the only way through. `--force` still governs the prompt,
 *     never the data.
 *   - Containers come down first. Removing the directory out from under running
 *     containers would leave them alive with a vanished bind mount.
 *
 * Deleting the directory releases the project's host ports implicitly: §5 scans
 * manifests, so a manifest that no longer exists holds nothing.
 */

import { rmSync } from 'node:fs'
import type { Context } from '../context.ts'
import { BardolierError } from '../errors.ts'
import { attachedKeys } from '../compose.ts'
import { extraPortNames } from '../extraports.ts'
import { dataDir, holdsData, homeDir, irreplaceableBytes } from '../layout.ts'
import { formatBytes } from '../volumes.ts'
import type { DeleteOutput } from '../model/lifecycle.ts'
import type { ProjectManifest } from '../model/project.ts'
import { findRoot } from '../projects.ts'
import { removeFromRootIndex } from '../rootindex.ts'
import { requireProject } from '../workspace.ts'
import { runDown } from './down.ts'

export type DeleteRequest = {
  readonly name: string | undefined
  readonly force: boolean
  readonly purge: boolean
  /** True under `--json`, where there is no way to ask a question (§2). */
  readonly json: boolean
}

function assignedPorts(manifest: ProjectManifest): number[] {
  const servicePorts = attachedKeys(manifest).map((key) => manifest.services?.[key]?.host_port)
  const extraPorts = extraPortNames(manifest).map((name) => manifest.extra_ports?.[name]?.host_port)
  return [...servicePorts, ...extraPorts]
    .filter((port): port is number => typeof port === 'number')
    .sort((a, b) => a - b)
}

export async function runDelete(ctx: Context, request: DeleteRequest): Promise<DeleteOutput> {
  const project = requireProject(ctx, request.name)
  const { manifest, dir } = project

  // Before the prompt, and before anything is stopped: a refusal must leave the
  // project exactly as it found it.
  if (!request.purge && holdsData(dir)) {
    const bytes = irreplaceableBytes(dir)
    throw new BardolierError(
      'PROJECT_HAS_DATA',
      `\`${manifest.name}\` holds ${formatBytes(bytes)} under ${dataDir(dir)} and ${homeDir(dir)}, and deleting the project removes them with it. Pass --purge to destroy them, or move what you want to keep out first.`,
      { project: manifest.name, dir, bytes },
    )
  }

  const ports = assignedPorts(manifest)

  if (!request.force) {
    if (request.json) {
      // A prompt on stdout would break the §2 single-JSON-value guarantee, and
      // the app does its own confirmation before calling with --force.
      throw new BardolierError(
        'INVALID_ARGUMENT',
        `Refusing to delete \`${manifest.name}\` without confirmation. Under --json, pass --force.`,
      )
    }
    const fate = request.purge
      ? `Delete ${dir} AND everything in it, including ${formatBytes(irreplaceableBytes(dir))} of service data and container home?`
      : `Delete ${dir}?`
    const confirmed = await ctx.confirm(fate)
    if (!confirmed) {
      return {
        project: manifest.name,
        deleted: false,
        dir,
        released_ports: [],
        removed_volumes: [],
        kept_volumes: [],
      }
    }
  }

  // No handoff: the directory it would be written into is removed below (§12).
  await runDown(ctx, manifest.name, { noHandoff: true })

  rmSync(dir, { recursive: true, force: true })

  // Write-through (§5, phase 27): a deleted project must stop being reported
  // as a name or port held anywhere, including by an offline root's index.
  const root = findRoot(ctx.config, project.root)
  if (root) removeFromRootIndex(ctx, root, manifest.name)

  return {
    project: manifest.name,
    deleted: true,
    dir,
    released_ports: ports,
    removed_volumes: [],
    kept_volumes: [],
  }
}

export function renderDelete(output: DeleteOutput): string[] {
  if (!output.deleted) return [`Left ${output.project} alone.`]

  const lines = [`Deleted ${output.project} (${output.dir}).`]
  if (output.released_ports.length > 0) lines.push(`  released ports: ${output.released_ports.join(', ')}`)
  return lines
}
