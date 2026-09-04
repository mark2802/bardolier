/**
 * `bandolier volumes orphaned | rm` — `cli-spec.md` §6 (Volumes / disk).
 *
 * `orphaned` is READ-ONLY (§2): it reports what could be reclaimed and touches
 * nothing. `rm` is the only command in the CLI whose whole purpose is to
 * destroy data, so it asks twice in effect — the scan has to agree the volume
 * is unclaimed, and the user has to confirm (unless `--force`).
 *
 * Both go through `volumes.ts`, which derives "claimed" from the manifests
 * under `$SSD_ROOT`. That is why `rm` can refuse VOLUME_IN_USE before Docker is
 * even asked: a volume a project still attaches is in use whether or not its
 * container happens to be up right now, and the running-container case is
 * caught underneath by `removeVolume` anyway.
 */

import type { Context } from '../context.ts'
import { BandolierError } from '../errors.ts'
import type { VolumesOrphanedOutput, VolumesRemoveOutput } from '../model/volumes.ts'
import { formatBytes, isCacheVolume, scanVolumes, UNKNOWN_SIZE, volumeOwner } from '../volumes.ts'

// ── orphaned ─────────────────────────────────────────────────────────────────

export async function collectOrphanedVolumes(ctx: Context): Promise<VolumesOrphanedOutput> {
  const scan = await scanVolumes(ctx)
  const total = scan.orphans.reduce((sum, volume) => sum + volume.size_bytes, 0)
  return {
    orphaned: [...scan.orphans],
    total_bytes: total,
    total_human: formatBytes(total),
  }
}

export function renderOrphanedVolumes(output: VolumesOrphanedOutput): string[] {
  if (output.orphaned.length === 0) return ['No orphaned volumes. Nothing to reclaim.']

  const lines = [`${output.orphaned.length} orphaned volume(s), ${output.total_human} reclaimable:`]
  for (const volume of output.orphaned) {
    lines.push(`  ${volume.name}  ${volume.size_human}  (was ${volume.last_project ?? 'unattributed'})`)
  }
  lines.push('')
  lines.push('Reclaim one with: bandolier volumes rm <name>   — this destroys its data.')
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
  if (!request.name) throw new BandolierError('INVALID_ARGUMENT', 'Usage: bandolier volumes rm <name> [--force]')
  const name = request.name

  const scan = await scanVolumes(ctx)
  const volume = scan.all.get(name)
  if (!volume) {
    throw new BandolierError('VOLUME_NOT_FOUND', `Docker has no volume named \`${name}\`.`, { volume: name })
  }

  const claimant = scan.claimedBy.get(name)
  if (claimant !== undefined) {
    // The cache volume is shared, so "detach the service" is not the way out of
    // this one: it goes when the last project built on that image goes.
    const message = isCacheVolume(volume)
      ? `\`${name}\` is the shared toolchain cache that \`${claimant}\` and every other project on its base image build with. It becomes reclaimable when the last of them is deleted.`
      : `\`${name}\` still belongs to project \`${claimant}\`. Detach the service (\`bandolier service remove ${claimant} <svc>\`) or delete the project first.`
    throw new BandolierError('VOLUME_IN_USE', message, { volume: name, project: claimant })
  }

  const orphan = scan.orphans.find((entry) => entry.name === name)
  const sizeBytes = orphan?.size_bytes ?? 0
  const sizeHuman = orphan?.size_human ?? UNKNOWN_SIZE
  const lastProject = orphan?.last_project ?? volumeOwner(volume)

  if (!request.force) {
    if (request.json) {
      // A prompt on stdout would break the §2 single-JSON-value guarantee; the
      // app confirms in its own UI and then calls with --force.
      throw new BandolierError(
        'INVALID_ARGUMENT',
        `Refusing to remove \`${name}\` without confirmation. Under --json, pass --force.`,
      )
    }
    const confirmed = await ctx.confirm(`Remove volume ${name} (${sizeHuman})? Its data is destroyed.`)
    if (!confirmed) {
      return { volume: name, removed: false, size_bytes: sizeBytes, size_human: sizeHuman, last_project: lastProject }
    }
  }

  // May still throw VOLUME_IN_USE: a container the scan cannot see (someone
  // else's, or one started since) can hold it. Docker's refusal wins.
  await ctx.docker.removeVolume(name)

  return { volume: name, removed: true, size_bytes: sizeBytes, size_human: sizeHuman, last_project: lastProject }
}

export function renderVolumeRemove(output: VolumesRemoveOutput): string[] {
  if (!output.removed) return [`Left ${output.volume} alone.`]
  const attribution = output.last_project ? ` (was ${output.last_project})` : ''
  return [`Removed volume ${output.volume}${attribution}, reclaiming ${output.size_human}.`]
}
