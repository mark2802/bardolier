/**
 * `bardolier env` output — `cli-spec.md` §6, §10.
 */

export type EnvOutput = {
  project: string
  /** Where `docs/env.md` lives (or would live) on the host. Absent without a `work_folder`. */
  path?: string
  /** The rendered document. */
  content: string
  /** True when `--write` was given. */
  written: boolean
  /** With `--write`: whether the bytes on disk changed. Otherwise whether they WOULD. */
  changed: boolean
}
