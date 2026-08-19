/**
 * Configuration — `cli-spec.md` §8.
 *
 * The config file lives on the INTERNAL disk (`~/.config/cproj/config.yml`) for
 * one reason: it must be readable while the SSD is unplugged, so `doctor` and
 * `status` can say "SSD not mounted" instead of failing. Nothing in this module
 * touches the SSD; loading never throws SSD_NOT_MOUNTED.
 *
 * Precedence, lowest to highest: built-in defaults → config file → environment.
 * §8 names `CPROJ_SSD_ROOT` and `CPROJ_SSD_VOLUME`; `CPROJ_CONFIG` is an
 * implementation addition that relocates the file itself, which is what keeps
 * tests and the done-check hermetic on a machine that has a real config.
 */

import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { isAbsolute, join, resolve } from 'node:path'
import { parse as parseYaml } from 'yaml'
import { CprojError } from './errors.ts'
import { assertValid } from './schema.ts'

export type Config = {
  /** Directory holding project dirs. Read for discovery; never created here. */
  readonly ssd_root: string
  /** Mount point of the SSD itself — what `eject` unmounts (Phase 4). */
  readonly ssd_volume: string
  /** Explicit catalogue location, or null to use the §4.1 fallback chain. */
  readonly catalogue_path: string | null
  /** Terminal the APP uses for shell-open. The CLI never spawns one. */
  readonly terminal: string
}

/** The file's shape: every key optional, since a missing file is legal. */
export type ConfigFile = Partial<{
  ssd_root: string
  ssd_volume: string
  catalogue_path: string
  terminal: string
}>

export type LoadedConfig = {
  readonly config: Config
  /** Absolute path consulted, whether or not it exists. */
  readonly path: string
  readonly exists: boolean
  /** Env vars that overrode a value, e.g. `['CPROJ_SSD_ROOT']`. */
  readonly overrides: readonly string[]
}

export const DEFAULT_SSD_VOLUME = '/Volumes/ssd'
export const DEFAULT_PROJECTS_DIRNAME = 'claude-projects'
export const DEFAULT_TERMINAL = 'Terminal'

export type Env = Readonly<Record<string, string | undefined>>

/** `~/x` → `/Users/you/x`; relative paths resolve against cwd. */
export function expandPath(value: string, home = homedir()): string {
  const expanded = value === '~' ? home : value.startsWith('~/') ? join(home, value.slice(2)) : value
  return isAbsolute(expanded) ? expanded : resolve(expanded)
}

export function defaultConfigPath(env: Env = process.env, home = homedir()): string {
  const override = env.CPROJ_CONFIG
  if (override && override.length > 0) return expandPath(override, home)
  const xdg = env.XDG_CONFIG_HOME
  const base = xdg && xdg.length > 0 ? expandPath(xdg, home) : join(home, '.config')
  return join(base, 'cproj', 'config.yml')
}

function readConfigFile(path: string): { file: ConfigFile; exists: boolean } {
  let text: string
  try {
    text = readFileSync(path, 'utf8')
  } catch (cause) {
    const code = (cause as NodeJS.ErrnoException).code
    // A missing file is the normal first-run state, not a failure. Anything
    // else (EACCES, EISDIR) is real and must not be silently defaulted away.
    if (code === 'ENOENT') return { file: {}, exists: false }
    throw new CprojError('CONFIG_INVALID', `Cannot read ${path}: ${(cause as Error).message}`)
  }

  let parsed: unknown
  try {
    parsed = parseYaml(text)
  } catch (cause) {
    throw new CprojError('CONFIG_INVALID', `${path} is not valid YAML: ${(cause as Error).message}`)
  }

  // An empty file parses to null; treat it as "no keys set".
  const value = parsed ?? {}
  const file = assertValid<ConfigFile>('config', value, path)
  return { file, exists: true }
}

export type LoadOptions = {
  readonly path?: string
  readonly env?: Env
  readonly home?: string
}

/**
 * Load config. Safe with the SSD absent, safe with no config file at all.
 * Throws only CONFIG_INVALID, and only when a file exists but is unusable.
 */
export function loadConfig(options: LoadOptions = {}): LoadedConfig {
  const env = options.env ?? process.env
  const home = options.home ?? homedir()
  const path = options.path ? expandPath(options.path, home) : defaultConfigPath(env, home)
  const { file, exists } = readConfigFile(path)

  const overrides: string[] = []
  const envRoot = env.CPROJ_SSD_ROOT
  const envVolume = env.CPROJ_SSD_VOLUME
  if (envRoot) overrides.push('CPROJ_SSD_ROOT')
  if (envVolume) overrides.push('CPROJ_SSD_VOLUME')

  const volume = expandPath(envVolume || file.ssd_volume || DEFAULT_SSD_VOLUME, home)
  // The root defaults *inside* the configured volume, so setting only
  // `ssd_volume` moves both and the two can never point at different disks.
  const root = expandPath(envRoot || file.ssd_root || join(volume, DEFAULT_PROJECTS_DIRNAME), home)

  return {
    config: {
      ssd_root: root,
      ssd_volume: volume,
      catalogue_path: file.catalogue_path ? expandPath(file.catalogue_path, home) : null,
      terminal: file.terminal || DEFAULT_TERMINAL,
    },
    path,
    exists,
    overrides,
  }
}
