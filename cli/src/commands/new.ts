/**
 * `cproj new <name> --archetype <a>` — `cli-spec.md` §6 (Projects), §10.
 *
 * Creates, in this order: the directory, the manifest, the seeded files, the
 * compose file. The manifest goes down before anything derived from it, so a
 * crash mid-way leaves a directory that `status` can still read rather than an
 * unattributable pile of files.
 *
 * The SSD must already be mounted. Creating `$SSD_ROOT` ourselves would put the
 * project on the internal disk the moment the disk was unplugged — exactly the
 * failure the split-storage design exists to prevent.
 */

import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Context } from '../context.ts'
import { CprojError } from '../errors.ts'
import { ARCHETYPES, ARCHETYPE_BASE_IMAGE, isArchetype } from '../model/archetype.ts'
import type { Archetype } from '../model/archetype.ts'
import type { ProjectManifest } from '../model/project.ts'
import type { NewOutput } from '../model/lifecycle.ts'
import { seededFiles } from '../scaffold.ts'
import { probeSsd } from '../projects.ts'
import { composePath, manifestPath, regenerateCompose, writeManifest } from '../workspace.ts'
import { validate } from '../schema.ts'

/** Mirrors `project.schema.json`'s `name` pattern; it is also a directory name. */
const NAME_PATTERN = /^[a-z0-9][a-z0-9._-]*$/

export type NewRequest = {
  readonly name: string | undefined
  readonly archetype: string | undefined
  /** Raw `--services a,b`. Port assignment lands in Phase 3. */
  readonly services: string | undefined
}

function requireName(name: string | undefined): string {
  if (!name) throw new CprojError('INVALID_ARGUMENT', 'Usage: cproj new <name> --archetype <a>')
  if (!NAME_PATTERN.test(name)) {
    throw new CprojError(
      'INVALID_ARGUMENT',
      `\`${name}\` is not a usable project name: use lower-case letters, digits, dot, dash or underscore, starting with a letter or digit.`,
    )
  }
  return name
}

function requireArchetype(value: string | undefined): Archetype {
  if (!value) {
    throw new CprojError('INVALID_ARGUMENT', `--archetype is required (one of: ${ARCHETYPES.join(', ')}).`)
  }
  if (!isArchetype(value)) {
    throw new CprojError('INVALID_ARGUMENT', `Unknown archetype \`${value}\`. Expected one of: ${ARCHETYPES.join(', ')}.`)
  }
  return value
}

export async function runNew(ctx: Context, request: NewRequest): Promise<NewOutput> {
  const name = requireName(request.name)
  const archetype = requireArchetype(request.archetype)

  if (request.services !== undefined) {
    // The flag is part of the frozen §6 surface, but honouring it needs the
    // port allocator. Refusing is better than creating a project whose
    // manifest quietly lacks the services the user asked for.
    throw new CprojError(
      'NOT_IMPLEMENTED',
      '`cproj new --services` needs the port allocator, which lands in Phase 3. Create the project, then `cproj service add`.',
    )
  }

  const ssd = probeSsd(ctx.config)
  if (!ssd.mounted) {
    throw new CprojError(
      'SSD_NOT_MOUNTED',
      `The SSD is not mounted at ${ctx.config.ssd_root}; refusing to create a project on the internal disk.`,
    )
  }

  const dir = join(ctx.config.ssd_root, name)
  if (existsSync(dir)) {
    throw new CprojError('PROJECT_EXISTS', `\`${name}\` already exists at ${dir}.`)
  }

  const manifest: ProjectManifest = {
    name,
    archetype,
    base_image: ARCHETYPE_BASE_IMAGE[archetype],
    created: ctx.now().toISOString(),
  }

  // Validate before writing: a manifest that fails its own schema would be
  // invisible to `status` the moment it hit the disk.
  const { valid, errors } = validate('project', manifest)
  if (!valid) {
    throw new CprojError('INTERNAL_ERROR', `Generated manifest does not match the project schema: ${errors.join('; ')}`)
  }

  mkdirSync(dir, { recursive: false })
  writeManifest(dir, manifest)

  const seeded: string[] = []
  for (const file of seededFiles(name, archetype)) {
    writeFileSync(join(dir, file.name), file.contents)
    seeded.push(file.name)
  }

  // No services yet, so the catalogue is not consulted — `new` works with a
  // broken catalogue, which `doctor` is the right place to complain about.
  regenerateCompose(dir, manifest, null)

  return {
    project: { name, archetype, base_image: manifest.base_image, dir, created: manifest.created },
    manifest_path: manifestPath(dir),
    compose_path: composePath(dir),
    seeded,
    services: [],
  }
}

export function renderNew(output: NewOutput): string[] {
  const { project } = output
  return [
    `Created ${project.name} [${project.archetype}] at ${project.dir}`,
    `  manifest: ${output.manifest_path}`,
    `  compose:  ${output.compose_path}  (generated — do not edit)`,
    `  seeded:   ${output.seeded.join(', ')}`,
    '',
    `Next: cproj service add ${project.name} postgres   # attach a service`,
    `      cproj up ${project.name}`,
  ]
}
