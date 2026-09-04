/**
 * `cproj deps add | remove | list` — `cli-spec.md` §6 (Deps), §4.2
 * (`extra_packages`); docs/phases/13-extra-packages.md.
 *
 * OS-level packages a project's toolchain needs beyond its base image
 * (Playwright's `libnss3`/`libatk`/… for `install-deps`), without baking them
 * into the shared base image (every project would pay for them) or
 * installing at runtime inside the container (no root there, and `down`
 * throws the writable layer away regardless). Root is confined to
 * image-build time — `up` builds the derived image before `composeUp`
 * (`deps.ts`).
 *
 * Add and remove REQUIRE THE PROJECT STOPPED, exactly like a service or an
 * extra port — `requireStopped`/`persist` are shared with `service.ts` rather
 * than reimplemented. `list` is Docker-free, manifest only.
 */

import type { Context } from '../context.ts'
import { CprojError } from '../errors.ts'
import { attachedPackages, selectedImage } from '../deps.ts'
import type { ProjectManifest } from '../model/project.ts'
import type { DepsAddOutput, DepsListOutput, DepsRemoveOutput } from '../model/deps.ts'
import { requireProject } from '../workspace.ts'
import { catalogueIfNeeded, persist, requireStopped } from './service.ts'

/** apt's own package-naming rule — this string reaches a shell command inside the generated Dockerfile. */
const PACKAGE_PATTERN = /^[a-z0-9][a-z0-9+.-]*$/

export type DepsRequest = {
  readonly project: string | undefined
  readonly packages: readonly string[]
}

function requirePackages(values: readonly string[], usage: string): string[] {
  if (values.length === 0) throw new CprojError('INVALID_ARGUMENT', `Usage: cproj ${usage}`)
  for (const name of values) {
    if (!PACKAGE_PATTERN.test(name)) {
      throw new CprojError('INVALID_ARGUMENT', `\`${name}\` is not a usable apt package name.`)
    }
  }
  return [...values]
}

// ── add ──────────────────────────────────────────────────────────────────────

export async function runDepsAdd(ctx: Context, request: DepsRequest): Promise<DepsAddOutput> {
  const project = requireProject(ctx, request.project)
  const packages = requirePackages(request.packages, 'deps add <project> <package...>')
  const { manifest, dir } = project

  const existing = new Set(manifest.extra_packages ?? [])
  const already = packages.find((name) => existing.has(name))
  if (already) {
    throw new CprojError(
      'PACKAGE_ATTACHED',
      `\`${already}\` is already declared on \`${manifest.name}\`.`,
      { project: manifest.name, package: already },
    )
  }

  await requireStopped(ctx, project, 'declaring an extra package')

  const next: ProjectManifest = { ...manifest, extra_packages: [...existing, ...packages].sort() }
  const catalogue = catalogueIfNeeded(ctx, next)
  persist(dir, next, catalogue)

  return { project: manifest.name, added: packages, extra_packages: attachedPackages(next), image: selectedImage(next) }
}

export function renderDepsAdd(output: DepsAddOutput): string[] {
  const noun = output.added.length === 1 ? 'package' : 'packages'
  return [
    `Declared ${noun} ${output.added.map((p) => `\`${p}\``).join(', ')} on ${output.project}.`,
    `  image: ${output.image}`,
    '',
    `Next: cproj up ${output.project}`,
  ]
}

// ── remove ───────────────────────────────────────────────────────────────────

export async function runDepsRemove(ctx: Context, request: DepsRequest): Promise<DepsRemoveOutput> {
  const project = requireProject(ctx, request.project)
  const packages = requirePackages(request.packages, 'deps remove <project> <package...>')
  const { manifest, dir } = project

  const declared = new Set(manifest.extra_packages ?? [])
  const missing = packages.find((name) => !declared.has(name))
  if (missing) {
    const list = [...declared].sort().join(', ')
    throw new CprojError(
      'PACKAGE_NOT_ATTACHED',
      `\`${missing}\` is not declared on \`${manifest.name}\`.${list ? ` Declared: ${list}.` : ''}`,
      { project: manifest.name, package: missing },
    )
  }

  await requireStopped(ctx, project, 'removing an extra package')

  const remaining = new Set(declared)
  for (const name of packages) remaining.delete(name)
  const next: ProjectManifest = { ...manifest, extra_packages: [...remaining].sort() }
  const catalogue = catalogueIfNeeded(ctx, next)
  persist(dir, next, catalogue)

  return { project: manifest.name, removed: packages, extra_packages: attachedPackages(next), image: selectedImage(next) }
}

export function renderDepsRemove(output: DepsRemoveOutput): string[] {
  const noun = output.removed.length === 1 ? 'package' : 'packages'
  return [
    `Removed ${noun} ${output.removed.map((p) => `\`${p}\``).join(', ')} from ${output.project}.`,
    `  image: ${output.image}`,
  ]
}

// ── list ─────────────────────────────────────────────────────────────────────

export function collectDepsList(ctx: Context, name: string | undefined): DepsListOutput {
  const project = requireProject(ctx, name)
  return { project: project.name, extra_packages: attachedPackages(project.manifest), image: selectedImage(project.manifest) }
}

export function renderDepsList(output: DepsListOutput): string[] {
  if (output.extra_packages.length === 0) {
    return [
      `${output.project} has no extra packages declared. Image: ${output.image}`,
      '',
      `Declare one with: cproj deps add ${output.project} <package>`,
    ]
  }
  return [
    `${output.project} extra packages:`,
    ...output.extra_packages.map((name) => `  ${name}`),
    `  image: ${output.image}`,
  ]
}
