/**
 * Root probing and project discovery — `cli-spec.md` §3.
 *
 * The manifests under `<root>/<project>/project.yml` are the only source of
 * truth read here; nothing is written, nothing is created. Discovery is
 * READ-ONLY, including "a root isn't there" — that is a reportable state, not
 * an exception (§8: status/doctor must still answer).
 *
 * The injection seam is `config.roots`: point them at temp dirs and the whole
 * layer is testable without a real disk. There can be many configured roots;
 * `mounted` on `Discovery` means "at least one root is readable" — so
 * `status` can go on answering when some, but not all, roots are gone.
 */

import { readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { parse as parseYaml } from 'yaml'
import type { Config, RootConfig } from './config.ts'
import { BardolierError } from './errors.ts'
import { validate } from './schema.ts'
import type { ProjectManifest } from './model/project.ts'

export const MANIFEST_FILENAME = 'project.yml'

/** The default root `new` targets absent `--root` — always `config.roots[0]`. */
export function defaultRoot(config: Config): RootConfig {
  return config.roots[0]!
}

export function findRoot(config: Config, name: string): RootConfig | null {
  return config.roots.find((root) => root.name === name) ?? null
}

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory()
  } catch {
    return false
  }
}

/**
 * Walk from `path` up to the last ancestor sharing its `st_dev` — a mount
 * boundary is a change of device number, so that ancestor IS the mount point.
 * Pure `stat`, no spawn, so `probeRoot` stays a filesystem check that never
 * throws and works with the root absent. `null` when `path` itself can't be
 * stat'd; a stat failure higher up just stops the walk there.
 */
export function containingVolume(path: string): string | null {
  let dev: number
  try {
    dev = statSync(path).dev
  } catch {
    return null
  }

  let mount = path
  let parent = dirname(mount)
  while (parent !== mount) {
    let parentDev: number
    try {
      parentDev = statSync(parent).dev
    } catch {
      break
    }
    if (parentDev !== dev) break
    mount = parent
    parent = dirname(mount)
  }
  return mount
}

/** A single root's readable/mount-point state, e.g. for `new --root` and `eject`. */
export type RootMount = {
  readonly name: string
  readonly path: string
  readonly mounted: boolean
  /** The mount point containing `path`. Null only when `path` isn't readable. */
  readonly volume: string | null
}

export function probeRoot(root: RootConfig): RootMount {
  const mounted = isDirectory(root.path)
  return { name: root.name, path: root.path, mounted, volume: mounted ? containingVolume(root.path) : null }
}

/** Per-root mounted state, as reported in `status.roots` and `Discovery.roots`. */
export type RootProbe = {
  readonly name: string
  readonly path: string
  readonly mounted: boolean
}

export type DiscoveredProject = {
  readonly name: string
  readonly dir: string
  readonly manifest: ProjectManifest
  /** The configured root's name this project was found under. */
  readonly root: string
}

/** A project dir whose manifest can't be trusted. Reported, never guessed at. */
export type InvalidProject = {
  readonly name: string
  readonly dir: string
  readonly reason: string
}

export type Discovery = {
  readonly roots: readonly RootProbe[]
  /** True when at least one root is readable. */
  readonly mounted: boolean
  /** Valid projects across every readable root, sorted by name so output is deterministic. */
  readonly projects: readonly DiscoveredProject[]
  readonly invalid: readonly InvalidProject[]
}

function readManifest(dir: string, name: string): { manifest: ProjectManifest } | InvalidProject | null {
  const path = join(dir, MANIFEST_FILENAME)
  let text: string
  try {
    text = readFileSync(path, 'utf8')
  } catch {
    // A directory without a manifest simply isn't a project — the user may keep
    // anything else under a root.
    return null
  }

  let parsed: unknown
  try {
    parsed = parseYaml(text)
  } catch (cause) {
    return { name, dir, reason: `${MANIFEST_FILENAME} is not valid YAML: ${(cause as Error).message}` }
  }

  const { valid, errors } = validate('project', parsed)
  if (!valid) return { name, dir, reason: `${MANIFEST_FILENAME} does not match the project schema: ${errors.join('; ')}` }

  const manifest = parsed as ProjectManifest
  if (manifest.name !== name) {
    return { name, dir, reason: `${MANIFEST_FILENAME} declares name "${manifest.name}" but lives in directory "${name}"` }
  }
  return { manifest }
}

function isInvalid(value: { manifest: ProjectManifest } | InvalidProject): value is InvalidProject {
  return 'reason' in value
}

export function discoverProjects(config: Config): Discovery {
  const roots: RootProbe[] = []
  const projects: DiscoveredProject[] = []
  const invalid: InvalidProject[] = []

  for (const root of config.roots) {
    let mounted = isDirectory(root.path)
    let entries: string[] = []
    if (mounted) {
      try {
        entries = readdirSync(root.path)
      } catch {
        // Readable as a stat but not as a listing (permissions, a yanked disk mid-call).
        mounted = false
      }
    }
    roots.push({ name: root.name, path: root.path, mounted })
    if (!mounted) continue

    for (const name of entries.sort()) {
      if (name.startsWith('.')) continue
      const dir = join(root.path, name)
      if (!isDirectory(dir)) continue
      const result = readManifest(dir, name)
      if (result === null) continue
      if (isInvalid(result)) invalid.push(result)
      else projects.push({ name, dir, manifest: result.manifest, root: root.name })
    }
  }

  projects.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
  invalid.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))

  return { roots, mounted: roots.some((r) => r.mounted), projects, invalid }
}

/** The roots in a Discovery that could not be read, e.g. for a ROOT_UNREADABLE detail. */
export function unreadableRoots(discovery: Discovery): readonly RootProbe[] {
  return discovery.roots.filter((root) => !root.mounted)
}

/** A ROOT_UNREADABLE naming the given roots — shared by the allocator and the volume scan. */
export function rootUnreadableError(roots: readonly RootProbe[]): BardolierError {
  const named = roots.map((root) => `${root.name} (${root.path})`).join(', ')
  return new BardolierError(
    'ROOT_UNREADABLE',
    `Cannot get a complete answer while ${roots.length === 1 ? 'this root is' : 'these roots are'} unreadable: ${named}.`,
    { roots: roots.map((root) => root.name) },
  )
}

/**
 * Find one project by name across every readable root, or null.
 *
 * A name found in more than one root is PROJECT_AMBIGUOUS: the two would
 * share a container name and a home volume, so there is no safe guess to make
 * — the caller names both directories and lets the user rename one.
 */
export function findProject(discovery: Discovery, name: string): DiscoveredProject | null {
  const matches = discovery.projects.filter((p) => p.name === name)
  if (matches.length > 1) {
    throw new BardolierError(
      'PROJECT_AMBIGUOUS',
      `\`${name}\` exists in more than one root: ${matches.map((p) => p.dir).join(', ')}. Rename one of them.`,
      { dirs: matches.map((p) => p.dir), roots: matches.map((p) => p.root) },
    )
  }
  return matches[0] ?? null
}
