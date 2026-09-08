/**
 * The root index — `cli-spec.md` §5, §8; `INTENT.md`'s "Cross-root knowledge
 * while a root is offline" decision. One JSON file per root, beside
 * `config.yml` on the internal disk, holding what that root's manifests
 * claimed the last time it was readable.
 *
 * NOT a second registry. Three rules keep it that way:
 *
 *   - One file per ROOT, in a shape `readManifest`/`workspace.ts` cannot
 *     parse — nothing that reads a manifest can mistake this for one.
 *   - It answers exactly three questions: is this name taken anywhere, is
 *     this port taken anywhere, which shared cache volume does an offline
 *     project still claim. Nothing here describes how to run, show, or act
 *     on a project — `status`, `up`, `requireProject` never read it.
 *   - It is consulted only for a root `discoverProjects` cannot reach. A
 *     readable root is rescanned and its file rewritten; the manifests
 *     always win.
 *
 * Kept fresh two ways, neither a poll: WRITE-THROUGH at every manifest write
 * (`workspace.ts:writeManifest` calls `upsertRootIndex`; `delete`/`move`
 * call `removeFromRootIndex`/`upsertRootIndex` directly), and full RECONCILE
 * wherever something already walks every readable root (`status`, `doctor`,
 * `eject`, via `reconcileReadableRoots`).
 *
 * Every write is best-effort, like `handoff.ts`'s: a sidecar cache must never
 * fail a command that otherwise succeeded. Keyed by the root's PATH, not its
 * name, so renaming a root (`root remove` + `root add` at the same path)
 * keeps its history instead of a rename silently starting cold.
 */

import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type { RootConfig } from './config.ts'
import type { Context } from './context.ts'
import { attachedKeys } from './compose.ts'
import { extraPortNames } from './extraports.ts'
import { DEV_SERVER_KEY } from './portkeys.ts'
import { unreadableRoots, type Discovery, type DiscoveredProject } from './projects.ts'
import { validate } from './schema.ts'
import type { ProjectManifest } from './model/project.ts'
import type { OfflineRoot, RootIndex, RootIndexProject } from './model/rootindex.ts'

const INDEX_DIR = 'root-index'

function indexDir(configPath: string): string {
  return join(dirname(configPath), INDEX_DIR)
}

function indexFile(configPath: string, root: Pick<RootConfig, 'path'>): string {
  const key = createHash('sha256').update(root.path).digest('hex').slice(0, 12)
  return join(indexDir(configPath), `${key}.json`)
}

/** The three facts this module exists to answer, read off one manifest. */
export function projectionFromManifest(manifest: ProjectManifest): RootIndexProject {
  const ports: RootIndexProject['ports'] = []
  if (typeof manifest.app_port === 'number') ports.push({ service: DEV_SERVER_KEY, host_port: manifest.app_port })
  for (const key of attachedKeys(manifest)) {
    const port = manifest.services?.[key]?.host_port
    if (typeof port === 'number') ports.push({ service: key, host_port: port })
  }
  for (const name of extraPortNames(manifest)) {
    const port = manifest.extra_ports?.[name]?.host_port
    if (typeof port === 'number') ports.push({ service: name, host_port: port })
  }
  return { name: manifest.name, archetype: manifest.archetype, base_image: manifest.base_image, ports }
}

/**
 * Read one root's index. Never throws: missing, unparseable or schema-invalid
 * is no different from never having scanned it, which is exactly the state
 * every caller here already has to handle.
 */
export function readRootIndex(configPath: string, root: Pick<RootConfig, 'name' | 'path'>): RootIndex | null {
  try {
    const raw: unknown = JSON.parse(readFileSync(indexFile(configPath, root), 'utf8'))
    const { valid } = validate('root-index', raw)
    return valid ? (raw as RootIndex) : null
  } catch {
    return null
  }
}

function writeRootIndex(configPath: string, index: RootIndex): void {
  // A malformed cache is worse than a missing one — validate rather than trust
  // it silently, the same rule `new`/`service add` apply to project.yml.
  if (!validate('root-index', index).valid) return
  try {
    mkdirSync(indexDir(configPath), { recursive: true })
    writeFileSync(indexFile(configPath, index.root), `${JSON.stringify(index, null, 2)}\n`)
  } catch {
    // Best-effort, like handoff.ts (§12): a cache must never fail a command
    // that otherwise succeeded at its real job.
  }
}

/** Full RECONCILE: rewrite one root's index from every project just discovered under it. */
function reconcileOne(configPath: string, root: Pick<RootConfig, 'name' | 'path'>, projects: readonly DiscoveredProject[], now: Date): void {
  writeRootIndex(configPath, {
    root: { name: root.name, path: root.path },
    scanned: now.toISOString(),
    projects: projects.map((p) => projectionFromManifest(p.manifest)),
  })
}

/**
 * Rewrite the index for every root a `Discovery` found readable. Called
 * wherever a command already walks every root — `status`, `doctor`, `eject`
 * — so this costs nothing beyond the scan those commands were doing anyway.
 */
export function reconcileReadableRoots(ctx: Context, discovery: Discovery): void {
  for (const root of discovery.roots) {
    if (!root.mounted) continue
    const projects = discovery.projects.filter((p) => p.root === root.name)
    reconcileOne(ctx.loaded.path, root, projects, ctx.now())
  }
}

/** WRITE-THROUGH: fold one just-written manifest into its root's index without a rescan. */
export function upsertRootIndex(ctx: Context, root: Pick<RootConfig, 'name' | 'path'>, manifest: ProjectManifest): void {
  const existing = readRootIndex(ctx.loaded.path, root)
  const projects = (existing?.projects ?? []).filter((p) => p.name !== manifest.name)
  projects.push(projectionFromManifest(manifest))
  writeRootIndex(ctx.loaded.path, { root: { name: root.name, path: root.path }, scanned: ctx.now().toISOString(), projects })
}

/** WRITE-THROUGH for `delete`/the source side of `move`: drop one project from its root's index. */
export function removeFromRootIndex(ctx: Context, root: Pick<RootConfig, 'name' | 'path'>, name: string): void {
  const existing = readRootIndex(ctx.loaded.path, root)
  if (!existing) return
  const projects = existing.projects.filter((p) => p.name !== name)
  writeRootIndex(ctx.loaded.path, { root: { name: root.name, path: root.path }, scanned: ctx.now().toISOString(), projects })
}

/** Every unreadable root in a `Discovery`, for a command's `degraded_roots` receipt. */
export function offlineRoots(ctx: Context, discovery: Discovery): OfflineRoot[] {
  return unreadableRoots(discovery).map((root) => {
    const index = readRootIndex(ctx.loaded.path, root)
    return { root: root.name, path: root.path, last_indexed: index?.scanned ?? null }
  })
}

/** Shared human-output line for a command's `degraded_roots` — `new`, `clone`, `service add`, `port add`. */
export function renderDegradedRoots(offline: readonly OfflineRoot[]): string[] {
  if (offline.length === 0) return []
  return offline.map((root) => {
    const seen = root.last_indexed ? `last seen ${root.last_indexed}` : 'never indexed'
    return `  note:      allocated while \`${root.root}\` was unreadable (${seen}) — verify with \`bardolier doctor\` once it's back.`
  })
}
