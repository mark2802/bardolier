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
  /**
   * Host port published for the archetype's dev server (§9,
   * `ARCHETYPE_APP_PORT`), assigned once and stable exactly like a service's.
   *
   * Absent means this project publishes nothing from its dev container — either
   * its archetype has no dev server, or it predates this field. A pre-existing
   * project gets one on its next `up`, which is the only moment its archetype
   * is known and the manifest is being written anyway.
   */
  app_port?: number
  /** RFC 3339 / ISO 8601 UTC timestamp. */
  created: string
}
