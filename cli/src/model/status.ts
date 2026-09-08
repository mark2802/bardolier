/**
 * `status` JSON — THE app's primary contract. `cli-spec.md` §7.
 *
 * Schema stability is the contract: once the app ships (Phase 5+), changes to
 * this shape are ADDITIVE ONLY. Never rename or remove a field; never narrow a
 * union. The Swift `Codable` models in `app/` mirror this file.
 */

import type { Archetype } from './archetype.ts'
import type { AttachedExtraPort } from './extraport.ts'

/** A project is `partial` when some but not all of its containers are up. */
export const PROJECT_STATES = ['running', 'stopped', 'partial'] as const
export type ProjectState = (typeof PROJECT_STATES)[number]

export const SERVICE_STATES = ['running', 'stopped'] as const
export type ServiceState = (typeof SERVICE_STATES)[number]

export type StatusService = {
  /** Catalogue key, e.g. `postgres`. */
  key: string
  /** Human label from the catalogue, e.g. `PostgreSQL`. */
  display: string
  state: ServiceState
  /** The debugging tap on the Mac (§5). NOT what the dev app connects to. */
  host_port: number
  /** Fixed port inside the container network — what the dev app connects to. */
  container_port: number
  /** Ready-to-copy string for host GUI tools, e.g. `postgresql://localhost:5433`. */
  connection_hint: string
}

export type StatusProject = {
  name: string
  /**
   * The project's directory (§3). Reported rather than left to the caller to
   * compose from `ssd.root`: "Open folder in Finder" must not require the app
   * to know the on-disk layout.
   */
  dir: string
  archetype: Archetype
  state: ProjectState
  services: StatusService[]
  /** Container name, or null when the project is stopped. */
  dev_container: string | null
  /**
   * Host port the archetype's dev server is published on (§9), or null when
   * this project publishes none — a non-web archetype, or one created before
   * the field existed and not yet restarted.
   */
  app_port: number | null
  /**
   * The URL that opens `app_port`, or null alongside it. Reported rather than
   * composed by the caller, for the same reason `connection_hint` is.
   */
  app_url: string | null
  /** Extra ports declared on this project (§5.1), sorted by name. Additive since Phase 12. */
  extra_ports?: AttachedExtraPort[]
  /** The configured root's name this project lives under. Additive since phase 18. */
  root?: string
  /**
   * `<dir>/work`, where repositories live and the dev container works (§4.2).
   * Reported for the same reason `dir` is: the app must never compose a path.
   * Additive since phase 19.
   */
  work_dir?: string
}

/** One configured root's readable state (phase 18). */
export type StatusRoot = {
  name: string
  path: string
  mounted: boolean
  /**
   * ISO 8601 UTC of the last time this root's manifests were scanned, or null
   * — either it is currently mounted (its index is reconciled on every status
   * call, so this stays uninteresting), or it has never been indexed at all.
   * Additive since phase 27.
   */
  last_indexed?: string | null
}

/** Both things `volumes orphaned` can offer to reclaim (phase 19). */
export const ORPHAN_KINDS = ['volume', 'directory'] as const
export type OrphanKind = (typeof ORPHAN_KINDS)[number]

export type OrphanedVolume = {
  /** A Docker volume name, or `<project>/<key>` for a data directory. */
  name: string
  /** Additive since phase 19; absent means `volume`. */
  kind?: OrphanKind
  /** Host path of a `directory` orphan; null for a named volume. Additive since phase 19. */
  path?: string | null
  size_bytes: number
  size_human: string
  /** Project it belonged to, or null if it can't be attributed. */
  last_project: string | null
}

export type Status = {
  ssd: { mounted: boolean; root: string }
  docker: { available: boolean }
  projects: StatusProject[]
  orphaned_volumes: OrphanedVolume[]
  /** Every configured root's readable state. Additive since phase 18. */
  roots?: StatusRoot[]
}
