/**
 * Payloads for the project lifecycle commands — `new`, `up`, `down`, `delete`
 * (`cli-spec.md` §6, Projects).
 *
 * These are app-facing contracts like §7's `status`: once the app ships
 * (Phase 5+) they change ADDITIVELY ONLY. Each one answers "what did this
 * command actually do?", because the app has to distinguish a real start from
 * an idempotent no-op to render its activity states honestly (app-spec.md §5).
 */

import type { Archetype, BaseImage } from './archetype.ts'
import type { ProjectState } from './status.ts'

export type NewProject = {
  name: string
  archetype: Archetype
  base_image: BaseImage
  /** Absolute path of the created project directory. */
  dir: string
  /** RFC 3339 UTC timestamp recorded in the manifest. */
  created: string
}

export type NewOutput = {
  project: NewProject
  manifest_path: string
  compose_path: string
  /** File names seeded per §10, in the order they were written. */
  seeded: string[]
  /** Catalogue keys attached at creation. Empty until Phase 3 lands `--services`. */
  services: string[]
}

/** What `up` published. Mirrors the §7 service fields the app needs immediately. */
export type UpService = {
  key: string
  host_port: number
  container_port: number
}

export type UpOutput = {
  project: string
  /** `running` on success; `partial` if Docker reports something still down. */
  state: ProjectState
  dev_container: string
  services: UpService[]
  /** True when the project was already up — `up` is idempotent (§2). */
  already_running: boolean
  /** True when the compose file on disk differed from the manifest and was rewritten. */
  compose_regenerated: boolean
  /**
   * The app's cue to open a shell after starting (§6, `--no-shell`). The CLI
   * never spawns a terminal itself; it only says whether one was asked for.
   */
  open_shell: boolean
}

export type DownOutput = {
  project: string
  /** Always `stopped` on success. */
  state: ProjectState
  /** False when the project was already down — `down` is idempotent (§2). */
  was_running: boolean
  /** Data always persists. Kept explicit so the app can say so in the UI. */
  data_kept: true
}

export type DeleteOutput = {
  project: string
  /** False when the user declined the confirmation; nothing was touched. */
  deleted: boolean
  /** The directory that was (or would have been) removed. */
  dir: string
  /** Host ports the project no longer holds — free for the next allocation (§5). */
  released_ports: number[]
  /** Named volumes removed under `--purge`. */
  removed_volumes: string[]
  /** Named volumes left behind under `--keep-data`; they become listed orphans. */
  kept_volumes: string[]
}
