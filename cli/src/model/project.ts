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

/**
 * A named port published from the dev container, independent of archetype —
 * `cli-spec.md` §5.1. Unlike a service, there is no catalogue entry behind it:
 * the caller states `container_port` and the allocator finds a free host port
 * starting there, exactly as it does for `app_port`.
 */
export type ProjectExtraPort = {
  /** Fixed port inside the container; whatever `port add --container-port` was given. */
  container_port: number
  /** Host port, assigned at `port add` and STABLE for life (§5), like a service's. */
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
   * Named ports published from the dev container beyond the archetype's own
   * `app_port` (§5.1) — a second frontend/backend a mobile client or another
   * browser tab needs to reach directly, or an interactive tool (a notebook
   * server, a debugger UI) on an archetype that otherwise publishes nothing.
   * Keyed by a user-chosen name, not a catalogue key. Absent/empty = none.
   */
  extra_ports?: Record<string, ProjectExtraPort>
  /**
   * OS-level apt packages this project's toolchain needs beyond its base
   * image (Playwright's `libnss3`/`libatk`/… and the like) — sorted, deduped.
   * Absent/empty means the dev container runs the plain base image;
   * otherwise it runs a derived image built at `up` (`deps.ts`).
   */
  extra_packages?: string[]
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
