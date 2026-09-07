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
import type { AttachedExtraPort } from './extraport.ts'
import type { AttachedService } from './service.ts'
import type { ProjectState } from './status.ts'

export type NewProject = {
  name: string
  archetype: Archetype
  base_image: BaseImage
  /** Absolute path of the created project directory. */
  dir: string
  /** RFC 3339 UTC timestamp recorded in the manifest. */
  created: string
  /** The configured root's name this project was created under (phase 18). */
  root: string
}

export type NewOutput = {
  project: NewProject
  manifest_path: string
  compose_path: string
  /** File names seeded per §10, in the order they were written. */
  seeded: string[]
  /**
   * Services attached at creation by `--services`, sorted by key, each with the
   * host port the allocator assigned it (§5). Empty without the flag.
   */
  services: AttachedService[]
}

/**
 * What `clone` created (phase 20) — `new`'s fields, plus what makes it a copy.
 *
 * The same shape as `NewOutput` on purpose: a clone IS a new project, and the
 * caller that renders one renders the other.
 */
export type CloneOutput = NewOutput & {
  /** The project this one was shaped from. Unchanged by the clone, always. */
  source: string
  /** True when all four folders of §3 were copied byte-for-byte. */
  with_content: boolean
  /** Bytes copied across those four folders; 0 for a shape-only clone. */
  bytes_copied: number
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
  /**
   * The dev server's host port and the URL that opens it (§9), or null for an
   * archetype that serves nothing. Additive since Phase 9.
   */
  app_port?: number | null
  app_url?: string | null
  /** Extra ports published alongside it (§5.1), sorted by name. Additive since Phase 12. */
  extra_ports?: AttachedExtraPort[]
}

export type DownOutput = {
  project: string
  /**
   * Where the handoff note was written (§12), or null when none was — no
   * repository and no agent session to describe, or `--no-handoff`. Additive
   * since Phase 9.
   */
  handoff_path?: string | null
  /** True when the agent's own summary made it into that note. */
  handoff_summarised?: boolean
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
  /**
   * Named volumes removed under `--purge`, and left behind without it.
   *
   * Both are empty since phase 19: a project's data lives inside its directory
   * and goes with it, and the only named volume left is the toolchain cache,
   * which belongs to every project on the base image and to none of them. The
   * fields stay because the app decodes them (§7's additive-only rule).
   */
  removed_volumes: string[]
  kept_volumes: string[]
}
