/**
 * Locating and installing `bardolier` on the host's PATH — the CLI-side half
 * of `BardolierExecutable.swift`'s search. Phase 28.
 *
 * A GUI app launched from Finder inherits almost no PATH
 * (`BardolierExecutable.swift`'s header), so the app searches a small set of
 * CONVENTIONAL directories rather than a shell's real one. `bardolier
 * install` (`commands/install.ts`) is what puts a symlink into one of them —
 * the same list, in the same order, so the two sides cannot disagree about
 * where counts as "installed". `doctor`'s `cli` finding (`commands/doctor.ts`)
 * asks the same question this module answers, to catch exactly the state
 * this phase exists to fix: a shell that finds `bardolier` (because ITS PATH
 * is real) while the app would not.
 *
 * This is the one module in the CLI that reaches at real, global host paths
 * — `/opt/homebrew/bin`, `~/.local/bin` — outside any configured root or the
 * config file. The MUTATING half (`chooseBinDir`, `linkOne`, `runInstall`)
 * takes an explicit directory (`--bin-dir` on the command, or a directory
 * list passed straight to `chooseBinDir`) rather than going through
 * `Context`, precisely so a test never has to touch the real ones. The
 * READ-ONLY half `doctor` asks — is anything already installed — IS on
 * `Context`, as `ctx.cli` (`createCliLocator` below): that finding reports
 * on real host state exactly like `ctx.device` does for `eject`, and a test
 * asserting a "healthy environment" needs to script the answer the same way.
 */

import { accessSync, constants, existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, statSync, symlinkSync, unlinkSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { BardolierError } from './errors.ts'
import type { InstallLink, InstallOutput } from './model/install.ts'

/** The two names `cli/package.json`'s `bin` map declares. */
export const INSTALL_NAMES = ['bardolier', 'bdlr'] as const

/**
 * Where a Mac keeps user-installed CLIs, in the order a shell would search
 * them. MUST match `BardolierExecutable.conventionalDirectories` (Swift) —
 * the app and this command have to agree on where counts as "installed".
 */
export function conventionalBinDirectories(home: string = homedir()): string[] {
  return ['/opt/homebrew/bin', '/usr/local/bin', join(home, '.local', 'bin'), join(home, '.npm-global', 'bin'), join(home, 'bin')]
}

/** What `BardolierExecutable.childSearchPath` falls back to after PATH. */
export const SYSTEM_BIN_DIRECTORIES = ['/usr/bin', '/bin', '/usr/sbin', '/sbin'] as const

/** `cli/bin/bardolier.js`'s real path — the one thing every link points at. */
export function shimPath(): string {
  return fileURLToPath(new URL('../bin/bardolier.js', import.meta.url))
}

function isExecutableFile(path: string): boolean {
  try {
    const stat = statSync(path)
    return stat.isFile() && (stat.mode & 0o111) !== 0
  } catch {
    return false
  }
}

/** What `doctor`'s `cli` finding asks through `Context` — see its header. */
export type CliLocator = {
  installed(): { dir: string; path: string } | null
}

/** The real locator: searches the real conventional directories. */
export function createCliLocator(): CliLocator {
  return { installed: () => findInstalled() }
}

/**
 * Where a `bardolier` executable resolves today, searching `dirs` in order —
 * the same directories and order the app searches by default, so `doctor`
 * answers the question the app is actually asking. A real shell's inherited
 * PATH is deliberately not consulted: a terminal already finds whatever IS on
 * its own PATH, which is not the gap this exists to catch.
 */
export function findInstalled(dirs: readonly string[] = conventionalBinDirectories()): { dir: string; path: string } | null {
  for (const dir of dirs) {
    const candidate = join(dir, 'bardolier')
    if (isExecutableFile(candidate)) return { dir, path: candidate }
  }
  return null
}

function isWritableDir(dir: string): boolean {
  try {
    if (!statSync(dir).isDirectory()) return false
    accessSync(dir, constants.W_OK)
    return true
  } catch {
    return false
  }
}

export type ChooseBinDirRequest = { readonly binDir?: string }

/**
 * Pick a target directory: the explicit `--bin-dir` if given, else the first
 * of `dirs` that already exists and is writable. If none does — plausible on
 * a bare Mac with neither Homebrew nor a user bin dir yet — `fallback`
 * (`~/.local/bin`, already in the search list above) is created rather than
 * this failing: the point of `install` is that a fresh clone works without
 * anyone editing a shell profile.
 */
export function chooseBinDir(
  request: ChooseBinDirRequest,
  dirs: readonly string[] = conventionalBinDirectories(),
  fallback: string = join(homedir(), '.local', 'bin'),
): { dir: string; created: boolean } {
  if (request.binDir !== undefined) {
    if (!isWritableDir(request.binDir)) {
      throw new BardolierError('INSTALL_NO_WRITABLE_DIR', `\`${request.binDir}\` does not exist or is not writable.`)
    }
    return { dir: request.binDir, created: false }
  }
  for (const dir of dirs) {
    if (isWritableDir(dir)) return { dir, created: false }
  }
  mkdirSync(fallback, { recursive: true })
  return { dir: fallback, created: true }
}

/**
 * Point `<binDir>/<name>` at `target`.
 *
 * A dangling symlink (its target no longer exists) is replaced without
 * `--force` — that is this repo's own litter, the same shape as a stale link
 * left behind by an old install under a since-renamed path. Anything else
 * already there — a real file, or a symlink pointing at something that DOES
 * exist — is refused unless `--force` names it. A directory is refused
 * either way; there is nothing safe to do with it here.
 */
export function linkOne(binDir: string, name: string, target: string, force: boolean): InstallLink {
  const path = join(binDir, name)

  let stat: ReturnType<typeof lstatSync> | null
  try {
    stat = lstatSync(path)
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code !== 'ENOENT') throw cause
    stat = null
  }

  if (stat === null) {
    symlinkSync(target, path)
    return { name, path, target, action: 'created' }
  }

  if (stat.isDirectory()) {
    throw new BardolierError('INSTALL_PATH_OCCUPIED', `${path} is a directory; move it aside and try again.`)
  }

  if (stat.isSymbolicLink() && existsSync(path) && realpathSync(path) === target) {
    return { name, path, target, action: 'already_linked' }
  }

  const dangling = stat.isSymbolicLink() && !existsSync(path)
  if (!dangling && !force) {
    throw new BardolierError(
      'INSTALL_PATH_OCCUPIED',
      `${path} already exists and is not a link this repo made. Pass --force to replace it.`,
    )
  }

  unlinkSync(path)
  symlinkSync(target, path)
  return { name, path, target, action: 'replaced' }
}

function engineRange(): string {
  const pkg = JSON.parse(readFileSync(fileURLToPath(new URL('../package.json', import.meta.url)), 'utf8')) as {
    engines?: { node?: string }
  }
  return pkg.engines?.node ?? ''
}

/**
 * `>=X.Y.Z` against the running process. No semver dependency for the one
 * comparison this needs — a version this simple parser cannot read is
 * treated as satisfied rather than failed, since the running process is the
 * only node this install ever runs under anyway.
 */
export function satisfiesNodeEngine(range: string, version: string = process.version): boolean {
  const want = range.match(/(\d+)\.(\d+)\.(\d+)/)
  const have = version.match(/(\d+)\.(\d+)\.(\d+)/)
  if (!want || !have) return true
  for (let i = 1; i <= 3; i += 1) {
    const w = Number(want[i])
    const h = Number(have[i])
    if (h > w) return true
    if (h < w) return false
  }
  return true
}

export type InstallRequest = {
  readonly binDir?: string
  readonly force: boolean
}

export function runInstall(request: InstallRequest): InstallOutput {
  const { dir: binDir, created } = chooseBinDir(request.binDir !== undefined ? { binDir: request.binDir } : {})
  const target = shimPath()
  const links = INSTALL_NAMES.map((name) => linkOne(binDir, name, target, request.force))

  return {
    bin_dir: binDir,
    links,
    created_bin_dir: created,
    node_version: process.version,
    node_ok: satisfiesNodeEngine(engineRange()),
    resolves: findInstalled([binDir, ...SYSTEM_BIN_DIRECTORIES]) !== null,
  }
}
