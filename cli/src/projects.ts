/**
 * SSD probing and project discovery — `cli-spec.md` §3.
 *
 * The manifests under `$SSD_ROOT/<project>/project.yml` are the only source of
 * truth read here; nothing is written, nothing is created. Discovery is
 * READ-ONLY, including "the SSD isn't there" — that is a reportable state, not
 * an exception (§8: status/doctor must still answer).
 *
 * The injection seam is the root path: point `ssd_root` at a temp dir and the
 * whole layer is testable without an SSD.
 */

import { readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { parse as parseYaml } from 'yaml'
import type { Config } from './config.ts'
import { validate } from './schema.ts'
import type { ProjectManifest } from './model/project.ts'

export const MANIFEST_FILENAME = 'project.yml'

export type SsdProbe = {
  /**
   * True when `$SSD_ROOT` is a readable directory. That is the criterion the §7
   * `ssd.mounted` boolean reports, because it is exactly the condition under
   * which projects can be listed.
   */
  readonly mounted: boolean
  readonly root: string
  /** The mount point containing `root` (phase 17). Null only when `root` isn't readable. */
  readonly volume: string | null
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
 * Pure `stat`, no spawn, so `probeSsd` stays a filesystem check that never
 * throws and works with the disk absent. `null` when `path` itself can't be
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

export function probeSsd(config: Config): SsdProbe {
  const mounted = isDirectory(config.ssd_root)
  return {
    mounted,
    root: config.ssd_root,
    volume: mounted ? containingVolume(config.ssd_root) : null,
  }
}

export type DiscoveredProject = {
  readonly name: string
  readonly dir: string
  readonly manifest: ProjectManifest
}

/** A project dir whose manifest can't be trusted. Reported, never guessed at. */
export type InvalidProject = {
  readonly name: string
  readonly dir: string
  readonly reason: string
}

export type Discovery = {
  readonly root: string
  readonly mounted: boolean
  /** Valid projects, sorted by name so output is deterministic. */
  readonly projects: readonly DiscoveredProject[]
  readonly invalid: readonly InvalidProject[]
}

function readManifest(dir: string, name: string): DiscoveredProject | InvalidProject | null {
  const path = join(dir, MANIFEST_FILENAME)
  let text: string
  try {
    text = readFileSync(path, 'utf8')
  } catch {
    // A directory without a manifest simply isn't a project — the user may keep
    // anything else under $SSD_ROOT.
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
  return { name, dir, manifest }
}

function isInvalid(value: DiscoveredProject | InvalidProject): value is InvalidProject {
  return 'reason' in value
}

export function discoverProjects(config: Config): Discovery {
  const root = config.ssd_root
  if (!isDirectory(root)) return { root, mounted: false, projects: [], invalid: [] }

  let entries: string[]
  try {
    entries = readdirSync(root)
  } catch {
    // Readable as a stat but not as a listing (permissions, a yanked disk mid-call).
    return { root, mounted: false, projects: [], invalid: [] }
  }

  const projects: DiscoveredProject[] = []
  const invalid: InvalidProject[] = []
  for (const name of entries.sort()) {
    if (name.startsWith('.')) continue
    const dir = join(root, name)
    if (!isDirectory(dir)) continue
    const result = readManifest(dir, name)
    if (result === null) continue
    if (isInvalid(result)) invalid.push(result)
    else projects.push(result)
  }

  return { root, mounted: true, projects, invalid }
}

/** Find one project by name, or null. Invalid manifests are reported separately. */
export function findProject(discovery: Discovery, name: string): DiscoveredProject | null {
  return discovery.projects.find((p) => p.name === name) ?? null
}
