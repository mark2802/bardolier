/**
 * Payloads for `cproj config get | set` — `cli-spec.md` §8.
 *
 * §8 defines the config FILE; these are the shapes the app reads and writes it
 * through. Preferences (`app-spec.md` §12) must not edit `config.yml` itself:
 * the CLI owns precedence (defaults → file → environment), path expansion, and
 * the `ssd_root`-defaults-inside-`ssd_volume` rule, and a second writer that
 * knew only some of that would produce a file the CLI reads differently from
 * the app that wrote it.
 */

import type { ConfigKey } from '../config.ts'

/** Every §8 key, resolved. Paths absolute and tilde-expanded. */
export type EffectiveConfig = {
  ssd_root: string
  ssd_volume: string
  /** null when unset — the §4.1 fallback chain applies. */
  catalogue_path: string | null
  terminal: string
}

export type ConfigGetOutput = {
  /** The file consulted, whether or not it exists. */
  path: string
  exists: boolean
  config: EffectiveConfig
  /**
   * Environment variables that overrode a value. A key named here cannot be
   * changed by writing the file, so the app reports that rather than appearing
   * to succeed.
   */
  overrides: string[]
}

export type ConfigSetOutput = {
  path: string
  created: boolean
  /** Keys whose stored value actually changed; empty means a no-op write. */
  changed: ConfigKey[]
  /** The effective config AFTER the write. */
  config: EffectiveConfig
  overrides: string[]
}
