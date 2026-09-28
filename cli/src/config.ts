/**
 * Configuration — `cli-spec.md` §8.
 *
 * The config file lives on the INTERNAL disk (`~/.config/bardolier/config.yml`) for
 * one reason: it must be readable while every root is unplugged, so `doctor`
 * and `status` can say "not readable" instead of failing. Nothing in this
 * module touches a root's filesystem beyond `stat`; loading never throws
 * ROOT_UNREADABLE or SSD_NOT_MOUNTED.
 *
 * Precedence, lowest to highest: built-in defaults → config file → environment.
 * The single `ssd_root` key is replaced by `roots`, an ordered array of
 * `{ name, path }` — projects now live in more than one place at once, and
 * the first entry is the default `new` targets. `$BDLR_SSD_ROOT` becomes
 * `$BARDOLIER_ROOT`, which REPLACES the whole list with one root named after
 * the path's basename — one variable, so every done-check stays hermetic with
 * a temp dir.
 *
 * There is no `ssd_volume` key: a root's mount point is derived from its
 * `path` by `containingVolume` in `projects.ts`, so the two can never
 * disagree. Together, dropping that key and replacing `ssd_root` spend §5's
 * additive-only rule twice — both deliberate, both before publication, the
 * one window in which breaking a frozen contract costs nothing.
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { basename, dirname, isAbsolute, join, resolve } from 'node:path'
import { homedir } from 'node:os'
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml'
import { BardolierError } from './errors.ts'
import { assertValid, validate } from './schema.ts'

/** One entry of `roots` — a name the user and the app refer to it by, plus its path. */
export type RootConfig = {
  readonly name: string
  readonly path: string
}

export type Config = {
  /** Ordered; `roots[0]` is the default `new` targets. Never empty. */
  readonly roots: readonly RootConfig[]
  /** Explicit catalogue location, or null to use the §4.1 fallback chain. */
  readonly catalogue_path: string | null
  /** Terminal the APP uses for shell-open. The CLI never spawns one. */
  readonly terminal: string
}

/** The file's shape: every key optional, since a missing file is legal. */
export type ConfigFile = Partial<{
  roots: { name: string; path: string }[]
  catalogue_path: string
  terminal: string
}>

export type LoadedConfig = {
  readonly config: Config
  /** Absolute path consulted, whether or not it exists. */
  readonly path: string
  readonly exists: boolean
  /** Env vars that overrode a value, e.g. `['BARDOLIER_ROOT']`. */
  readonly overrides: readonly string[]
  /**
   * The inputs this load used, kept so a caller can reload the same way after
   * writing (`config set`, `root add|remove`). Without them a reload would
   * silently fall back to the real `process.env` and the real `$HOME` — which
   * is exactly the seam `LoadOptions` exists to close.
   */
  readonly home: string
  readonly env: Env
}

/** A published tool must not assume `/Volumes/ssd` exists. */
export const DEFAULT_ROOT_PATH = '~/bardolier-projects'
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

const ROOT_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/

export function isValidRootName(name: string): boolean {
  return ROOT_NAME_PATTERN.test(name)
}

/** A usable root name derived from a path's basename, for the env override and `root add` without `--name`. */
export function nameFromPath(path: string): string {
  const base = basename(path)
  if (base.length > 0 && ROOT_NAME_PATTERN.test(base)) return base
  const sanitized = base.replace(/[^A-Za-z0-9._-]/g, '-').replace(/^[.\-_]+/, '')
  return sanitized.length > 0 ? sanitized : 'root'
}

/** Names unique, paths unique — a root that collided with itself would corrupt §5 and volume ownership alike. */
function assertUniqueRoots(roots: readonly RootConfig[], where: string): void {
  const names = new Set<string>()
  const paths = new Set<string>()
  for (const root of roots) {
    if (names.has(root.name)) throw new BardolierError('CONFIG_INVALID', `${where}: duplicate root name \`${root.name}\`.`)
    if (paths.has(root.path)) throw new BardolierError('CONFIG_INVALID', `${where}: duplicate root path ${root.path}.`)
    names.add(root.name)
    paths.add(root.path)
  }
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

/**
 * The roots the FILE declares, defaulted and expanded but ignorant of any
 * environment override — `root add`/`root remove` edit this list, not the
 * effective one `$BARDOLIER_ROOT` might be standing in for.
 *
 * A file with no `roots` key materialises the built-in default: this is what
 * makes `root add`'s first call turn the implicit default into an explicit
 * `roots[0]` rather than losing it.
 */
export function currentRoots(path: string, home = homedir()): RootConfig[] {
  const { file } = readConfigFile(path)
  if (file.roots && file.roots.length > 0) {
    const roots = file.roots.map((root) => ({ name: root.name, path: expandPath(root.path, home) }))
    assertUniqueRoots(roots, path)
    return roots
  }
  const expanded = expandPath(DEFAULT_ROOT_PATH, home)
  return [{ name: nameFromPath(expanded), path: expanded }]
}

export type LoadOptions = {
  readonly path?: string
  readonly env?: Env
  readonly home?: string
}

/**
 * Load config. Safe with every root absent, safe with no config file at all.
 * Throws only CONFIG_INVALID, and only when a file exists but is unusable.
 */
export function loadConfig(options: LoadOptions = {}): LoadedConfig {
  const env = options.env ?? process.env
  const home = options.home ?? homedir()
  const path = options.path ? expandPath(options.path, home) : defaultConfigPath(env, home)
  const { file, exists } = readConfigFile(path)

  const overrides: string[] = []
  const envRoot = env.BARDOLIER_ROOT
  let roots: RootConfig[]
  if (envRoot) {
    overrides.push('BARDOLIER_ROOT')
    const expanded = expandPath(envRoot, home)
    roots = [{ name: nameFromPath(expanded), path: expanded }]
  } else {
    roots = currentRoots(path, home)
  }

  return {
    config: {
      roots,
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
 * The keys a caller may set through `config set`. `roots` is list-valued and
 * gets its own command surface (`root add | remove | list`, `commands/root.ts`)
 * — the same reasoning that gave `catalogue` and `config get|set` their own
 * commands rather than a text field the app would have to compose.
 */
export const CONFIG_KEYS = ['catalogue_path', 'terminal'] as const
export type ConfigKey = (typeof CONFIG_KEYS)[number]

export function isConfigKey(value: string): value is ConfigKey {
  return (CONFIG_KEYS as readonly string[]).includes(value)
}

const FILE_KEY_ORDER = ['roots', 'catalogue_path', 'terminal'] as const

/** Validate against the schema, then write with a stable key order — round-trips to identical bytes. */
function persist(path: string, next: ConfigFile): void {
  const { valid, errors } = validate('config', next)
  if (!valid) {
    throw new BardolierError('CONFIG_INVALID', `Refusing to write ${path}: ${errors.join('; ')}`)
  }
  mkdirSync(dirname(path), { recursive: true })
  const ordered: ConfigFile = {}
  for (const key of FILE_KEY_ORDER) {
    if (key === 'roots') {
      if (next.roots !== undefined) ordered.roots = next.roots
    } else if (next[key] !== undefined) {
      ordered[key] = next[key]
    }
  }
  writeFileSync(path, Object.keys(ordered).length === 0 ? '{}\n' : stringifyYaml(ordered), 'utf8')
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
 * acceptable because the file is a handful of keys the app also edits, and the
 * alternative (patching YAML text) is a parser this project does not need.
 * An empty value clears a key rather than storing an empty string, which the
 * schema forbids anyway; that is how Preferences returns to a default.
 *
 * Nothing here validates that a path exists. A root is routinely absent —
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

  persist(path, next)
  return { path, created: !exists, changed }
}

// ── Roots (`bardolier root add | remove | list`) ──────────────────────────────────

export type RootWrite = {
  readonly path: string
  readonly created: boolean
}

/** Append a root to the file, materialising the built-in default first if the file had none. */
export function addRootToFile(path: string, root: RootConfig, home = homedir()): RootWrite {
  const { file, exists } = readConfigFile(path)
  const existing = currentRoots(path, home)
  const byName = existing.find((r) => r.name === root.name)
  if (byName) throw new BardolierError('CONFIG_INVALID', `A root named \`${root.name}\` already exists (${byName.path}).`)
  const byPath = existing.find((r) => r.path === root.path)
  if (byPath) throw new BardolierError('CONFIG_INVALID', `${root.path} is already registered as root \`${byPath.name}\`.`)

  const next: ConfigFile = { ...file, roots: [...existing, root] }
  persist(path, next)
  return { path, created: !exists }
}

export type RootRemoval = {
  readonly path: string
  readonly removed: RootConfig
}

/** Forget a root by name. Never touches the directory it pointed at. */
export function removeRootFromFile(path: string, name: string, home = homedir()): RootRemoval {
  const { file } = readConfigFile(path)
  const existing = currentRoots(path, home)
  const index = existing.findIndex((r) => r.name === name)
  if (index === -1) {
    throw new BardolierError(
      'INVALID_ARGUMENT',
      `No root named \`${name}\`. Configured roots: ${existing.map((r) => r.name).join(', ')}.`,
    )
  }
  // `roots` is never empty (see the `Config` type): forgetting the last one
  // wouldn't leave zero roots, it would silently rematerialise the built-in
  // default on the next load — a root nobody asked for, standing in for the
  // one that was just removed. Add the replacement first.
  if (existing.length === 1) {
    throw new BardolierError(
      'INVALID_ARGUMENT',
      `\`${name}\` is the only configured root. Add another with \`bardolier root add\` before removing it.`,
    )
  }
  const removed = existing[index]!
  const remaining = existing.filter((_, i) => i !== index)

  const next: ConfigFile = { ...file, roots: remaining }
  persist(path, next)
  return { path, removed }
}
