/**
 * Orphan derivation — `cli-spec.md` §6 (Volumes / disk), §7.
 *
 * An orphan is something this tool made that NOTHING now claims. Since phase 19
 * there are two kinds, derived two different ways, because they are two
 * different risks:
 *
 *   - A DIRECTORY under a project's own `data/`. Claimed while the manifest
 *     beside it still attaches that catalogue key; reclaimable once it does
 *     not. This is `ls data/` minus the manifest's keys — no labels, no
 *     Docker, and no cross-root reasoning: the answer needs only the one root
 *     that holds the project, so another root being unplugged cannot make it
 *     wrong.
 *   - A NAMED VOLUME. Only the shared toolchain caches are still made
 *     (`images.ts`), claimed while ANY manifest names their base image, so this
 *     scan still needs EVERY manifest. Volumes left by an older layout still
 *     carry our labels and are still listed — leaving them out would hide
 *     gigabytes from the one command whose job is to account for them.
 *
 * An unreadable root no longer refuses this outright (phase 27): its ROOT
 * INDEX (`rootindex.ts`) supplies the cache claims a rescan would have found.
 * A root that has never been indexed cannot be guessed at the way a port can
 * — reporting its cache orphaned could destroy a project's build cache the
 * moment it comes back — so the scan degrades instead: directory orphans
 * (safe; per-root) are still reported, and NAMED VOLUMES are omitted
 * entirely, with `unverified_roots` naming why.
 *
 * Two refusals remain, because being wrong here destroys data:
 *   - No root readable at all: every bardolier volume would look orphaned. That
 *     is SSD_NOT_MOUNTED, never an empty claim-set.
 *   - An unreadable manifest is a project whose attachments cannot be known,
 *     so the scan refuses (CONFIG_INVALID) rather than under-reporting what is
 *     claimed. `doctor` is where that gets diagnosed.
 */

import { rmSync } from 'node:fs'
import type { Context } from './context.ts'
import { BardolierError } from './errors.ts'
import { attachedKeys, cacheFor, LABEL_PROJECT, LABEL_ROLE, ROLE_CACHE } from './compose.ts'
import { IMAGE_CACHE } from './images.ts'
import { dataDir, directorySize, serviceDataDir, subdirectories } from './layout.ts'
import { discoverProjects, unreadableRoots, type DiscoveredProject } from './projects.ts'
import { readRootIndex } from './rootindex.ts'
import type { DockerVolume } from './docker.ts'
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

/**
 * How a data directory is named in the orphan list and to `volumes rm`:
 * `<project>/<key>`. A Docker volume name can never contain a slash, so the two
 * kinds share one namespace without colliding.
 */
export function dataOrphanName(project: string, key: string): string {
  return `${project}/${key}`
}

export type VolumeScan = {
  /** Orphan name → the project that still claims it. Absent = nothing claims it. */
  readonly claimedBy: ReadonlyMap<string, string>
  /** Every volume Docker reports, by name. Empty when any root is unverified (see below). */
  readonly all: ReadonlyMap<string, DockerVolume>
  /** Everything ours that nothing claims, both kinds, sorted by name. */
  readonly orphans: readonly OrphanedVolume[]
  /**
   * Roots this scan could not read AND have never been indexed — named-volume
   * orphans are omitted entirely while this is non-empty (phase 27; directory
   * orphans are unaffected, they never needed more than the one root).
   */
  readonly unverifiedRoots: readonly string[]
}

/** The project a volume was made for, from the labels the compose file wrote (§9). */
export function volumeOwner(volume: DockerVolume): string | null {
  const project = volume.labels[LABEL_PROJECT]
  return project && project.length > 0 ? project : null
}

/** True for a shared toolchain cache volume, which has no owning project. */
export function isCacheVolume(volume: DockerVolume): boolean {
  return volume.labels[LABEL_ROLE] === ROLE_CACHE
}

/** True for a volume this tool created — our project label, or the cache role. */
export function isBardolierVolume(volume: DockerVolume): boolean {
  return volumeOwner(volume) !== null || isCacheVolume(volume)
}

type Claims = {
  /** Cache volume name → a project that still builds on its base image. */
  readonly names: ReadonlyMap<string, string>
  /** Every project whose manifest could be read. */
  readonly projects: readonly DiscoveredProject[]
  /**
   * Unreadable roots with no index to fall back on — named-volume claims
   * cannot be trusted while any of these is non-empty (see module header).
   */
  readonly unverifiedRoots: readonly string[]
}

/** Everything the manifests under every configured root claim. One walk. */
function claimsFromManifests(ctx: Context): Claims {
  const discovery = discoverProjects(ctx.config)
  if (!discovery.mounted) {
    throw new BardolierError(
      'SSD_NOT_MOUNTED',
      `No configured root is readable, so bardolier cannot tell which volumes are still in use. Mount one before reclaiming disk.`,
    )
  }
  if (discovery.invalid.length > 0) {
    const broken = discovery.invalid.map((p) => p.name).join(', ')
    throw new BardolierError(
      'CONFIG_INVALID',
      `Cannot tell which volumes are in use while these projects have unusable manifests: ${broken}. Run \`bardolier doctor\`.`,
    )
  }

  const names = new Map<string, string>()
  for (const project of discovery.projects) {
    // The cache is claimed by the base image, not by any attachment — a bare
    // android project with no services still builds with it. `projects` is
    // sorted, so the project named in a VOLUME_IN_USE refusal is stable.
    const cache = cacheFor(project.manifest)
    if (cache && !names.has(cache.volume)) names.set(cache.volume, project.name)
  }

  const unverifiedRoots: string[] = []
  for (const root of unreadableRoots(discovery)) {
    const index = readRootIndex(ctx.loaded.path, root)
    if (!index) {
      unverifiedRoots.push(root.name)
      continue
    }
    for (const project of index.projects) {
      const cache = IMAGE_CACHE[project.base_image]
      if (cache && !names.has(cache.volume)) names.set(cache.volume, project.name)
    }
  }

  return { names, projects: discovery.projects, unverifiedRoots }
}

/**
 * The data directories one project holds that its manifest no longer attaches.
 *
 * Only SUBDIRECTORIES, because only a directory is what a service's mount
 * makes. That is also what keeps the Spotlight marker `data/` is created with,
 * and any other loose file someone drops in, out of a destructive command's
 * list.
 */
function dataOrphans(project: DiscoveredProject): OrphanedVolume[] {
  const attached = new Set(attachedKeys(project.manifest))
  const rows: OrphanedVolume[] = []
  for (const name of subdirectories(dataDir(project.dir))) {
    if (attached.has(name)) continue
    const path = serviceDataDir(project.dir, name)
    const bytes = directorySize(path)
    rows.push({
      name: dataOrphanName(project.name, name),
      kind: 'directory',
      path,
      size_bytes: bytes,
      size_human: formatBytes(bytes),
      last_project: project.name,
    })
  }
  return rows
}

/**
 * Scan for both kinds of orphan.
 *
 * Volume sizes cost a `docker system df -v`, so they are fetched only when
 * there is a volume orphan to size — the common case (nothing to reclaim)
 * stays a single cheap `volume ls`.
 */
export async function scanVolumes(ctx: Context): Promise<VolumeScan> {
  const { names, projects, unverifiedRoots } = claimsFromManifests(ctx)

  const all = new Map<string, DockerVolume>()
  const claimedBy = new Map<string, string>()
  let orphans: OrphanedVolume[] = []

  // Named-volume claims cannot be trusted while a root is both unreadable and
  // never indexed (see module header) — skip the Docker side of the scan
  // entirely rather than risk calling an unverifiable claim orphaned.
  if (unverifiedRoots.length === 0) {
    const volumes = await ctx.docker.volumes()
    const candidates: DockerVolume[] = []
    for (const volume of volumes) {
      all.set(volume.name, volume)
      const claimant = names.get(volume.name)
      if (claimant !== undefined) {
        claimedBy.set(volume.name, claimant)
        continue
      }
      // Only volumes this tool made are ours to offer for reclaiming. Somebody
      // else's `docker volume create` is none of our business.
      if (isBardolierVolume(volume)) candidates.push(volume)
    }

    const sizes = candidates.length > 0 ? await ctx.docker.volumeSizes() : new Map<string, number>()
    orphans = candidates.map((volume): OrphanedVolume => {
      const bytes = sizes.get(volume.name)
      return {
        name: volume.name,
        kind: 'volume',
        path: null,
        size_bytes: bytes ?? 0,
        size_human: bytes === undefined ? UNKNOWN_SIZE : formatBytes(bytes),
        last_project: volumeOwner(volume),
      }
    })
  }

  for (const project of projects) {
    for (const key of attachedKeys(project.manifest)) {
      claimedBy.set(dataOrphanName(project.name, key), project.name)
    }
    orphans.push(...dataOrphans(project))
  }

  orphans.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
  return { claimedBy, all, orphans, unverifiedRoots }
}

/**
 * Destroy one reclaimed orphan, whichever kind it is.
 *
 * A directory is removed from the host filesystem; a volume goes through
 * Docker, which may still refuse (a container the scan cannot see can hold it)
 * and whose refusal wins.
 */
export async function removeOrphan(ctx: Context, orphan: OrphanedVolume): Promise<void> {
  if (orphan.kind === 'directory') {
    if (orphan.path) rmSync(orphan.path, { recursive: true, force: true })
    return
  }
  await ctx.docker.removeVolume(orphan.name)
}
