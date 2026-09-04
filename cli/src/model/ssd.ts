/**
 * Payloads for `bardolier down-all` and `bardolier eject` — `cli-spec.md` §6
 * (Lifecycle / SSD).
 *
 * `eject` is the one command whose FAILURE the app renders in detail: on
 * EJECT_BLOCKED the error's `details.holders` carries these same holder
 * records, so the menu can say "Xcode (pid 431) is holding the SSD" instead of
 * "eject failed" (app-spec.md §10). The success payload and the failure detail
 * therefore share one holder shape.
 *
 * App-facing: additive changes only once the app ships (Phase 5+).
 */

/** A process holding files open on the SSD, as `lsof` reports it. */
export type EjectHolder = {
  pid: number
  /** Process name, e.g. `Xcode`, `zsh`. */
  command: string
  /** Login name of the owner, or null when the probe did not say. */
  user: string | null
  /** Paths under the volume it holds — enough to recognise, not a file listing. */
  paths: string[]
}

/** One project `down-all` considered. */
export type DownAllProject = {
  name: string
  /** True when something of this project was up and has now been stopped. */
  was_running: boolean
}

export type DownAllOutput = {
  /** Every discovered project, sorted by name. */
  projects: DownAllProject[]
  /** Names of the projects actually stopped by this call, sorted. */
  stopped: string[]
  /**
   * `bardolier-*` containers removed that no manifest claims — left behind by a
   * deleted project, or by a compose file that has since changed.
   */
  stray_containers: string[]
  /**
   * False when the daemon was unreachable. Nothing can be running in that case,
   * so this is a no-op success rather than a failure — `eject` still needs an
   * answer (§6).
   */
  docker_available: boolean
}

export type EjectOutput = {
  /** The mount point that was ejected, e.g. `/Volumes/ssd`. */
  volume: string
  ejected: true
  /** What `down-all` stopped on the way, sorted. */
  stopped: string[]
  /** Always empty on success: a held volume is EJECT_BLOCKED, never a force. */
  holders: EjectHolder[]
  /**
   * True when the Docker engine had to be stopped for the unmount to go
   * through — Docker Desktop's file share holds the volume for as long as its
   * VM lives (§6). Reported because it is a side effect the user has to undo
   * (`docker desktop start`) before the next `up`, not just a detail of how the
   * eject went. Optional in the schema: an older app build decodes without it.
   */
  docker_stopped: boolean
}
