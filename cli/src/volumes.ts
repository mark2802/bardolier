/**
 * Orphaned-volume derivation — `cli-spec.md` §6 (Volumes / disk), §7.
 *
 * An orphan is a volume this tool created that NOTHING now claims. "Claims" is
 * answered from the manifests under `$SSD_ROOT` and nowhere else: `project.yml`
 * is the truth, the compose file is generated from it, and a second registry of
 * volumes would be one more thing to desync (CLAUDE.md, one source of truth).
 *
 * A volume is claimed when either
 *   - its NAME is one the catalogue would generate for a service some manifest
 *     still attaches, or
 *   - its `bardolier.project` / `bardolier.service` LABELS name a project that still
 *     attaches that service key.
 *
 * The second rule is not redundant. A manifest can attach a service the
 * catalogue no longer defines; its volume name is then unknowable, and without
 * the label rule that live volume would be listed as reclaimable. Being wrong
 * in that direction destroys data, so both rules are asked and either protects.
 *
 * A toolchain cache volume (`bardolier.role: cache`, `images.ts`) is the one volume
 * this tool makes that belongs to no project: it is shared by every project on
 * one base image, so it is claimed while ANY manifest names that image, and
 * reclaimable once none does. It is still ours — leaving it out entirely would
 * hide gigabytes of rebuildable data from the one command whose job is to
 * account for them.
 *
 * Two refusals guard the same edge:
 *   - With the SSD unmounted there are no manifests to consult, so EVERY bardolier
 *     volume would look orphaned. That is SSD_NOT_MOUNTED, never an empty
 *     claim-set.
 *   - An unreadable manifest is a project whose attachments cannot be known, so
 *     the scan refuses (CONFIG_INVALID) rather than under-reporting what is
 *     claimed. `doctor` is where that gets diagnosed.
 */

import type { Context } from './context.ts'
import { BardolierError } from './errors.ts'
import { attachedKeys, cacheFor, LABEL_PROJECT, LABEL_ROLE, LABEL_SERVICE, ROLE_CACHE, volumeName } from './compose.ts'
import { discoverProjects, rootUnreadableError, unreadableRoots } from './projects.ts'
import { homeVolumeName } from './naming.ts'
import type { DockerVolume } from './docker.ts'
import type { ResolvedCatalogue } from './catalogue.ts'
import type { OrphanedVolume } from './model/status.ts'

/** Rendered when Docker cannot say how big a volume is. */
export const UNKNOWN_SIZE = 'unknown'

const UNITS = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'] as const

/**
 * Bytes as §7 writes them: `20971520` → `20 MB`. Binary divisors with the short
 * unit names, which is the pairing the spec's own example uses.
 */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return UNKNOWN_SIZE
  let value = bytes
  let unit = 0
  while (value >= 1024 && unit < UNITS.length - 1) {
    value /= 1024
    unit += 1
  }
  const rounded = unit === 0 || value >= 10 || Number.isInteger(value) ? Math.round(value) : Math.round(value * 10) / 10
  return `${rounded} ${UNITS[unit]}`
}

export type VolumeScan = {
  /** Volume name → the project that still claims it. Absent = nothing claims it. */
  readonly claimedBy: ReadonlyMap<string, string>
  /** Every volume Docker reports, by name. */
  readonly all: ReadonlyMap<string, DockerVolume>
  /** bardolier-owned volumes nothing claims, sorted by name. */
  readonly orphans: readonly OrphanedVolume[]
}

/** The project a volume was made for, from the labels the compose file wrote (§9). */
export function volumeOwner(volume: DockerVolume): string | null {
  const project = volume.labels[LABEL_PROJECT]
  return project && project.length > 0 ? project : null
}

/** True for the shared toolchain cache volume, which has no owning project. */
export function isCacheVolume(volume: DockerVolume): boolean {
  return volume.labels[LABEL_ROLE] === ROLE_CACHE
}

/** True for a volume this tool created — our project label, or the cache role. */
export function isBardolierVolume(volume: DockerVolume): boolean {
  return volumeOwner(volume) !== null || isCacheVolume(volume)
}

type Claims = {
  /** Volume name → owning project, for names the catalogue can resolve. */
  readonly names: ReadonlyMap<string, string>
  /** `"<project> <service>"` for every attachment any manifest declares. */
  readonly attachments: ReadonlySet<string>
}

/** Everything the manifests under every configured root claim. One walk, both rules. */
function claimsFromManifests(ctx: Context): Claims {
  const discovery = discoverProjects(ctx.config)
  if (!discovery.mounted) {
    throw new BardolierError(
      'SSD_NOT_MOUNTED',
      `No configured root is readable, so bardolier cannot tell which volumes are still in use. Mount one before reclaiming disk.`,
    )
  }
  // Some, but not all, roots readable: a PARTIAL view is the dangerous case —
  // silently scanning only what's reachable would call the other root's
  // volumes orphaned. Total absence above is the worse, already-handled case.
  const unreadable = unreadableRoots(discovery)
  if (unreadable.length > 0) throw rootUnreadableError(unreadable)
  if (discovery.invalid.length > 0) {
    const broken = discovery.invalid.map((p) => p.name).join(', ')
    throw new BardolierError(
      'CONFIG_INVALID',
      `Cannot tell which volumes are in use while these projects have unusable manifests: ${broken}. Run \`bardolier doctor\`.`,
    )
  }

  const names = new Map<string, string>()
  const attachments = new Set<string>()
  // Resolved once, and only when something is attached: a project with no
  // services needs no catalogue at all.
  let catalogue: ResolvedCatalogue | null = null

  for (const project of discovery.projects) {
    // The dev container's $HOME is claimed by the project existing at all — it
    // needs no attachment and no catalogue, which is why it is asserted here
    // rather than in the loop below. Deleting the project is what releases it.
    names.set(homeVolumeName(project.name), project.name)

    // The cache is claimed by the base image, not by any attachment — a bare
    // android project with no services still builds with it. `projects` is
    // sorted, so the project named in a VOLUME_IN_USE refusal is stable.
    const cache = cacheFor(project.manifest)
    if (cache && !names.has(cache.volume)) names.set(cache.volume, project.name)

    const keys = attachedKeys(project.manifest)
    if (keys.length === 0) continue
    catalogue ??= ctx.catalogue()
    for (const key of keys) {
      attachments.add(`${project.name} ${key}`)
      const definition = catalogue.catalogue.services[key]
      if (definition) names.set(volumeName(definition, project.name), project.name)
    }
  }

  return { names, attachments }
}

/**
 * Scan Docker's volumes against the manifests.
 *
 * Sizes cost a `docker system df -v`, so they are fetched only when there is an
 * orphan to size — the common case (nothing to reclaim) stays a single cheap
 * `volume ls`.
 */
export async function scanVolumes(ctx: Context): Promise<VolumeScan> {
  const { names, attachments } = claimsFromManifests(ctx)
  const volumes = await ctx.docker.volumes()

  const all = new Map<string, DockerVolume>()
  const claimedBy = new Map<string, string>()
  const candidates: DockerVolume[] = []

  for (const volume of volumes) {
    all.set(volume.name, volume)
    const owner = volumeOwner(volume)
    const service = volume.labels[LABEL_SERVICE] ?? ''
    const byName = names.get(volume.name)
    const byLabel = owner !== null && service.length > 0 && attachments.has(`${owner} ${service}`) ? owner : undefined
    const claimant = byName ?? byLabel
    if (claimant !== undefined) {
      claimedBy.set(volume.name, claimant)
      continue
    }
    // Only volumes this tool made are ours to offer for reclaiming. Somebody
    // else's `docker volume create` is none of our business.
    if (isBardolierVolume(volume)) candidates.push(volume)
  }

  const sizes = candidates.length > 0 ? await ctx.docker.volumeSizes() : new Map<string, number>()
  const orphans = candidates
    .map((volume): OrphanedVolume => {
      const bytes = sizes.get(volume.name)
      return {
        name: volume.name,
        size_bytes: bytes ?? 0,
        size_human: bytes === undefined ? UNKNOWN_SIZE : formatBytes(bytes),
        last_project: volumeOwner(volume),
      }
    })
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))

  return { claimedBy, all, orphans }
}
