/**
 * Payload for `bardolier teardown` — `cli-spec.md` §6 (Lifecycle / SSD).
 *
 * The inverse of `install` plus `down-all`, for undoing a `README.md` Install
 * section end to end. Deliberately narrow: it never touches a project
 * directory, a named service/cache volume, or a configured root's contents —
 * `down-all`'s own "data always persists" promise, extended to config and the
 * PATH links rather than to anything holding data.
 */

import type { UninstallLink } from './install.ts'

export type TeardownOutput = {
  /** False when the user declined the confirmation (or --force was absent under --json, which throws before this is built); nothing below was touched. */
  confirmed: boolean
  /** Projects `down-all` stopped on the way, sorted. */
  stopped: string[]
  /** `bardolier-*` containers removed that no manifest claimed. */
  stray_containers: string[]
  /** False when the daemon was unreachable — containers, symlinks, config are handled regardless. */
  docker_available: boolean
  /** `~/.config/bardolier` (or `$BARDOLIER_CONFIG`'s directory) — config.yml and the root index both live here. */
  config_dir: string
  /** False when there was nothing there to begin with. */
  config_removed: boolean
  /** `bardolier`/`bdlr` links this checkout owned and removed, across every conventional bin directory. */
  unlinked: UninstallLink[]
  /**
   * Base image tags removed — only when `--images` was passed. Empty
   * (not omitted) when `--images` was not given, so the app never has to
   * infer the flag from an absent key.
   */
  images_removed: string[]
}
