/**
 * Payloads for `bardolier volumes orphaned | rm` — `cli-spec.md` §6 (Volumes / disk).
 *
 * The row shape is §7's `orphaned_volumes` entry, imported rather than
 * redeclared: the app's reclaim view (app-spec.md §9) renders the same rows it
 * gets from `status`, and two definitions would eventually disagree about what
 * an orphan looks like.
 *
 * App-facing: additive changes only once the app depends on this shape.
 */

import type { OrphanedVolume, OrphanKind } from './status.ts'

export type { OrphanedVolume }

export type VolumesOrphanedOutput = {
  /** Reclaimable volumes and data directories, sorted by name. */
  orphaned: OrphanedVolume[]
  /** Sum of `size_bytes` — what reclaiming all of them would free. */
  total_bytes: number
  total_human: string
  /**
   * Roots this scan skipped named-volume claims for, because they are both
   * unreadable and never indexed — present only when non-empty.
   * Directory orphans above are unaffected and still complete.
   */
  unverified_roots?: string[]
}

export type VolumesRemoveOutput = {
  /** The orphan's name — a Docker volume, or `<project>/<key>`. */
  volume: string
  /** Additive; absent means `volume`. */
  kind?: OrphanKind
  /** Host path of a `directory` orphan; null for a named volume. Additive. */
  path?: string | null
  /** False when the user declined the confirmation; nothing was touched. */
  removed: boolean
  /** Size at the moment it was removed; 0 when Docker could not measure it. */
  size_bytes: number
  size_human: string
  /** Project it belonged to, or null when it can't be attributed. */
  last_project: string | null
}
