/**
 * Payloads for `cproj volumes orphaned | rm` — `cli-spec.md` §6 (Volumes / disk).
 *
 * The row shape is §7's `orphaned_volumes` entry, imported rather than
 * redeclared: the app's reclaim view (app-spec.md §9) renders the same rows it
 * gets from `status`, and two definitions would eventually disagree about what
 * an orphan looks like.
 *
 * App-facing: additive changes only once the app ships (Phase 5+).
 */

import type { OrphanedVolume } from './status.ts'

export type { OrphanedVolume }

export type VolumesOrphanedOutput = {
  /** Reclaimable volumes, sorted by name. */
  orphaned: OrphanedVolume[]
  /** Sum of `size_bytes` — what reclaiming all of them would free. */
  total_bytes: number
  total_human: string
}

export type VolumesRemoveOutput = {
  volume: string
  /** False when the user declined the confirmation; nothing was touched. */
  removed: boolean
  /** Size at the moment it was removed; 0 when Docker could not measure it. */
  size_bytes: number
  size_human: string
  /** Project the volume belonged to, or null when it can't be attributed. */
  last_project: string | null
}
