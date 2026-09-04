/**
 * Configuration — `cli-spec.md` §8.
 *
 * The config file lives on the INTERNAL disk (`~/.config/bardolier/config.yml`) for
 * one reason: it must be readable while the SSD is unplugged, so `doctor` and
 * `status` can say "SSD not mounted" instead of failing. Nothing in this module
 * touches the SSD; loading never throws SSD_NOT_MOUNTED.
 *
 * Precedence, lowest to highest: built-in defaults → config file → environment.
 * §8 names `BDLR_SSD_ROOT` and `BDLR_SSD_VOLUME`; `BARDOLIER_CONFIG` is an
 * implementation addition that relocates the file itself, which is what keeps
 * tests and the done-check hermetic on a machine that has a real config.
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml'
import { BardolierError } from './errors.ts'
import { assertValid, validate } from './schema.ts'

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
  /** Env vars that overrode a value, e.g. `['BDLR_SSD_ROOT']`. */
  readonly overrides: readonly string[]
  /**
   * The inputs this load used, kept so a caller can reload the same way after
   * writing (`config set`). Without them a reload would silently fall back to
   * the real `process.env` and the real `$HOME` — which is exactly the seam
   * `LoadOptions` exists to close.
   */
  readonly home: string
  readonly env: Env
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
  const override = env.BARDOLIER_CONFIG
  if (override && override.length > 0) return expandPath(override, home)
  const xdg = env.XDG_CONFIG_HOME
  const base = xdg && xdg.length > 0 ? expandPath(xdg, home) : join(home, '.config')
  return join(base, 'bardolier', 'config.yml')
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
    throw new BardolierError('CONFIG_INVALID', `Cannot read ${path}: ${(cause as Error).message}`)
  }

  let parsed: unknown
  try {
    parsed = parseYaml(text)
  } catch (cause) {
    throw new BardolierError('CONFIG_INVALID', `${path} is not valid YAML: ${(cause as Error).message}`)
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
  const envRoot = env.BDLR_SSD_ROOT
  const envVolume = env.BDLR_SSD_VOLUME
  if (envRoot) overrides.push('BDLR_SSD_ROOT')
  if (envVolume) overrides.push('BDLR_SSD_VOLUME')

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
    home,
    env,
  }
}

// ── Writing (`bardolier config set`, app-spec.md §12) ────────────────────────────

/**
 * The keys a caller may set. Mirrors `config.schema.json`'s properties, and
 * `test/contracts.test.ts` holds the two together — a key the schema accepts
 * but this rejects would be settable by hand and not by the app, which is the
 * kind of split that makes Preferences lie.
 */
export const CONFIG_KEYS = ['ssd_root', 'ssd_volume', 'catalogue_path', 'terminal'] as const
export type ConfigKey = (typeof CONFIG_KEYS)[number]

export function isConfigKey(value: string): value is ConfigKey {
  return (CONFIG_KEYS as readonly string[]).includes(value)
}

export type ConfigWrite = {
  readonly path: string
  /** True when the file (or its directory) had to be created. */
  readonly created: boolean
  /** Keys whose stored value actually changed; empty means a no-op write. */
  readonly changed: readonly ConfigKey[]
}

/**
 * Set or clear keys in the config file.
 *
 * The file is REWRITTEN from its parsed keys, so any comments in it are lost —
 * acceptable because the file is four keys the app also edits, and the
 * alternative (patching YAML text) is a parser this project does not need.
 * An empty value clears a key rather than storing an empty string, which the
 * schema forbids anyway; that is how Preferences returns to a default.
 *
 * Nothing here validates that a path exists. The SSD is routinely absent —
 * refusing to record where it will be would make the preference unusable
 * exactly when it is needed.
 */
export function writeConfig(path: string, updates: Readonly<Partial<Record<ConfigKey, string>>>, home = homedir()): ConfigWrite {
  const { file, exists } = readConfigFile(path)
  const next: ConfigFile = { ...file }
  const changed: ConfigKey[] = []

  for (const key of CONFIG_KEYS) {
    const value = updates[key]
    if (value === undefined) continue
    const trimmed = value.trim()
    // Paths are expanded on the way IN so the stored value is what the CLI
    // will use; `terminal` is an app name, not a path, and is stored verbatim.
    const stored = trimmed === '' ? undefined : key === 'terminal' ? trimmed : expandPath(trimmed, home)
    if (next[key] === stored) continue
    if (stored === undefined) delete next[key]
    else next[key] = stored
    changed.push(key)
  }

  if (changed.length === 0 && exists) return { path, created: false, changed: [] }

  const { valid, errors } = validate('config', next)
  if (!valid) {
    throw new BardolierError('CONFIG_INVALID', `Refusing to write ${path}: ${errors.join('; ')}`)
  }

  try {
    mkdirSync(dirname(path), { recursive: true })
    // Ordered by CONFIG_KEYS rather than by insertion, so rewriting the file
    // twice with the same values produces the same bytes.
    const ordered: ConfigFile = {}
    for (const key of CONFIG_KEYS) {
      const value = next[key]
      if (value !== undefined) ordered[key] = value
    }
    writeFileSync(path, Object.keys(ordered).length === 0 ? '{}\n' : stringifyYaml(ordered), 'utf8')
  } catch (cause) {
    throw new BardolierError('CONFIG_INVALID', `Cannot write ${path}: ${(cause as Error).message}`)
  }

  return { path, created: !exists, changed }
}
