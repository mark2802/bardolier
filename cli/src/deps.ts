/**
 * Extra OS packages a project's toolchain needs beyond its base image —
 * `cli-spec.md` §6 (Deps), §4.2 (`extra_packages`); docs/phases/13-extra-packages.md.
 * The read model plus the derived-image mechanics shared by `deps
 * add/remove/list` (`commands/deps.ts`), `compose.ts` and `up.ts`.
 *
 * A derived image is CONTENT-ADDRESSED, not per-project:
 * `bandolier-deps-<baseImage>:<hash>`, hash a short sha256 of the base image plus
 * the sorted package list — so two projects declaring the same packages on
 * the same base image share one image and one build, the same reasoning as
 * `IMAGE_CACHE` (`images.ts`). The Dockerfile is written to
 * `~/.config/bandolier/deps-images/<hash>/Dockerfile` — the internal disk,
 * alongside `config.yml`, never the SSD (disk frugality) — and regenerated
 * deterministically on every `up`, exactly like `docker-compose.yml`; never
 * hand-edited.
 */

import { createHash } from 'node:crypto'
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type { BaseImage } from './model/archetype.ts'
import type { ProjectManifest } from './model/project.ts'

/** Declared extra packages, sorted — `deps list`'s read path. */
export function attachedPackages(manifest: ProjectManifest): string[] {
  return [...(manifest.extra_packages ?? [])].sort()
}

/** Short content hash of the base image plus its package set. */
function derivedHash(baseImage: BaseImage, packages: readonly string[]): string {
  const hash = createHash('sha256')
  hash.update(baseImage)
  for (const name of [...packages].sort()) hash.update(`\n${name}`)
  return hash.digest('hex').slice(0, 12)
}

/**
 * `bandolier-deps-<baseImage>:<hash>` — content-addressed, so two projects with
 * the same base image and the same package set resolve to the same tag.
 */
export function derivedImageTag(baseImage: BaseImage, packages: readonly string[]): string {
  return `bandolier-deps-${baseImage}:${derivedHash(baseImage, packages)}`
}

/**
 * The generated Dockerfile text. No `ARG`s: the caller already has concrete
 * uid/gid from `ctx.host`, unlike the base images (built once for whoever
 * runs `bandolier build`). Root is confined to this one `RUN`, image-build time
 * only — back to the identity the base image already switched to afterward.
 */
export function derivedDockerfile(baseImage: BaseImage, packages: readonly string[], uid: number, gid: number): string {
  const sorted = [...packages].sort()
  return [
    `FROM ${baseImage}:latest`,
    'USER root',
    `RUN apt-get update && apt-get install -y --no-install-recommends ${sorted.join(' ')} && rm -rf /var/lib/apt/lists/*`,
    `USER ${uid}:${gid}`,
    '',
  ].join('\n')
}

/**
 * The image `compose.ts`/`up.ts` should use for this manifest — the plain
 * base image when nothing is declared, the derived one otherwise.
 */
export function selectedImage(manifest: ProjectManifest): string {
  const packages = attachedPackages(manifest)
  return packages.length > 0 ? derivedImageTag(manifest.base_image, packages) : `${manifest.base_image}:latest`
}

/**
 * Write the derived Dockerfile to the internal disk, alongside `config.yml`.
 * Returns what `Docker.build` needs to build it. Called only when packages is
 * non-empty — a caller with nothing declared has no derived image to write.
 */
export function writeDerivedDockerfile(
  configPath: string,
  baseImage: BaseImage,
  packages: readonly string[],
  uid: number,
  gid: number,
): { readonly context: string; readonly dockerfile: string } {
  const context = join(dirname(configPath), 'deps-images', derivedHash(baseImage, packages))
  mkdirSync(context, { recursive: true })
  const dockerfile = join(context, 'Dockerfile')
  writeFileSync(dockerfile, derivedDockerfile(baseImage, packages, uid, gid))
  return { context, dockerfile }
}
