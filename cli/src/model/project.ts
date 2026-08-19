/**
 * Project manifest — `project.yml`. `cli-spec.md` §4.2.
 *
 * ONE SOURCE OF TRUTH: this manifest is the truth for its project. The compose
 * file is generated from it and never hand-edited, and assigned host ports live
 * here rather than in a separate registry that could desync (§5, step 2).
 */

import type { Archetype, BaseImage } from './archetype.ts'

/** A service attached to a project. The host port is assigned once and persisted. */
export type ProjectService = {
  /**
   * Host port, assigned at `service add` and STABLE for the life of the
   * attachment (§5). Released only on `service remove` / `project delete`.
   */
  host_port: number
}

export type ProjectManifest = {
  name: string
  archetype: Archetype
  /** Resolved from `archetype` via ARCHETYPE_BASE_IMAGE. */
  base_image: BaseImage
  /** Keyed by catalogue key (`postgres`, `redis`, …). Absent/empty = no services. */
  services?: Record<string, ProjectService>
  /** RFC 3339 / ISO 8601 UTC timestamp. */
  created: string
}
