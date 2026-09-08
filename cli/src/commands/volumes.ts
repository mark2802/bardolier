/**
 * `bardolier volumes orphaned | rm` — `cli-spec.md` §6 (Volumes / disk).
 *
 * `orphaned` is READ-ONLY (§2): it reports what could be reclaimed and touches
 * nothing. `rm` is the only command in the CLI whose whole purpose is to
 * destroy data, so it asks twice in effect — the scan has to agree the thing is
 * unclaimed, and the user has to confirm (unless `--force`).
 *
 * Both go through `volumes.ts`, which derives "claimed" from the manifests
 * under every configured root. That is why `rm` can refuse VOLUME_IN_USE before
 * Docker is even asked: a service a project still attaches is in use whether or
 * not its container happens to be up right now, and for a named volume the
 * running-container case is caught underneath by `removeVolume` anyway.
 *
 * Since phase 19 an orphan is either a named volume or a project's leftover
 * data directory (`<project>/<key>`). `rm` takes either — by that name, or by
 * the directory's own path, which is what the human output shows.
 */

import type { Context } from '../context.ts'
import { BardolierError } from '../errors.ts'
import type { VolumesOrphanedOutput, VolumesRemoveOutput } from '../model/volumes.ts'
import { formatBytes, isCacheVolume, removeOrphan, scanVolumes } from '../volumes.ts'

// ── orphaned ─────────────────────────────────────────────────────────────────

export async function collectOrphanedVolumes(ctx: Context): Promise<VolumesOrphanedOutput> {
  const scan = await scanVolumes(ctx)
  const total = scan.orphans.reduce((sum, volume) => sum + volume.size_bytes, 0)
  return {
    orphaned: [...scan.orphans],
    total_bytes: total,
    total_human: formatBytes(total),
    ...(scan.unverifiedRoots.length > 0 ? { unverified_roots: [...scan.unverifiedRoots] } : {}),
  }
}

export function renderOrphanedVolumes(output: VolumesOrphanedOutput): string[] {
  const lines: string[] = []
  if (output.orphaned.length === 0) {
    lines.push('No orphans. Nothing to reclaim.')
  } else {
    lines.push(`${output.orphaned.length} orphan(s), ${output.total_human} reclaimable:`)
    for (const orphan of output.orphaned) {
      const where = orphan.kind === 'directory' ? `  ${orphan.path}` : ''
      lines.push(`  ${orphan.name}  ${orphan.size_human}  (was ${orphan.last_project ?? 'unattributed'})${where}`)
    }
    lines.push('')
    lines.push('Reclaim one with: bardolier volumes rm <name>   — this destroys its data.')
  }
  if (output.unverified_roots && output.unverified_roots.length > 0) {
    lines.push('')
    lines.push(`Named volumes on ${output.unverified_roots.join(', ')} were skipped — unreadable and never indexed. Plug in, then re-run.`)
  }
  return lines
}

// ── rm ───────────────────────────────────────────────────────────────────────

export type VolumeRemoveRequest = {
  readonly name: string | undefined
  readonly force: boolean
  /** True under `--json`, where there is no way to ask a question (§2). */
  readonly json: boolean
}

export async function runVolumeRemove(ctx: Context, request: VolumeRemoveRequest): Promise<VolumesRemoveOutput> {
  if (!request.name) throw new BardolierError('INVALID_ARGUMENT', 'Usage: bardolier volumes rm <name> [--force]')
  const name = request.name

  const scan = await scanVolumes(ctx)
  // A directory orphan answers to its `<project>/<key>` name and to its path;
  // the human listing shows both, so either is a fair thing to paste back.
  const orphan = scan.orphans.find((entry) => entry.name === name || entry.path === name)

  if (!orphan) {
    const claimant = scan.claimedBy.get(name)
    if (claimant !== undefined) {
      const volume = scan.all.get(name)
      // The cache volume is shared, so "detach the service" is not the way out
      // of this one: it goes when the last project on that image goes.
      const message =
        volume && isCacheVolume(volume)
          ? `\`${name}\` is the shared toolchain cache that \`${claimant}\` and every other project on its base image build with. It becomes reclaimable when the last of them is deleted.`
          : `\`${name}\` still belongs to project \`${claimant}\`. Detach the service (\`bardolier service remove ${claimant} <svc>\`) or delete the project first.`
      throw new BardolierError('VOLUME_IN_USE', message, { volume: name, project: claimant })
    }
    throw new BardolierError(
      'VOLUME_NOT_FOUND',
      `Nothing reclaimable is called \`${name}\` — no Docker volume, and no project's leftover data directory. Run \`bardolier volumes orphaned\`.`,
      { volume: name },
    )
  }

  const result: VolumesRemoveOutput = {
    volume: orphan.name,
    kind: orphan.kind ?? 'volume',
    path: orphan.path ?? null,
    removed: false,
    size_bytes: orphan.size_bytes,
    size_human: orphan.size_human,
    last_project: orphan.last_project,
  }

  if (!request.force) {
    if (request.json) {
      // A prompt on stdout would break the §2 single-JSON-value guarantee; the
      // app confirms in its own UI and then calls with --force.
      throw new BardolierError(
        'INVALID_ARGUMENT',
        `Refusing to remove \`${orphan.name}\` without confirmation. Under --json, pass --force.`,
      )
    }
    const what = orphan.kind === 'directory' ? `directory ${orphan.path}` : `volume ${orphan.name}`
    const confirmed = await ctx.confirm(`Remove ${what} (${orphan.size_human})? Its data is destroyed.`)
    if (!confirmed) return result
  }

  await removeOrphan(ctx, orphan)

  return { ...result, removed: true }
}

export function renderVolumeRemove(output: VolumesRemoveOutput): string[] {
  if (!output.removed) return [`Left ${output.volume} alone.`]
  const attribution = output.last_project ? ` (was ${output.last_project})` : ''
  const what = output.kind === 'directory' ? (output.path ?? output.volume) : `volume ${output.volume}`
  return [`Removed ${what}${attribution}, reclaiming ${output.size_human}.`]
}
