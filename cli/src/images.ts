/**
 * Base images on disk — the other half of the §4.3 archetype map.
 *
 * `model/archetype.ts` says WHICH image an archetype uses; this says whether
 * that image's Dockerfile exists yet. The `ios` and `android` bases land in
 * Phase 8, so "declared but not written" is a normal state that `build` and
 * `doctor` both have to describe honestly rather than treat as an error.
 */

import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { ARCHETYPES, ARCHETYPE_BASE_IMAGE, BASE_IMAGES } from './model/archetype.ts'
import type { Archetype, BaseImage } from './model/archetype.ts'

export type ImageDefinition = {
  readonly image: BaseImage
  /** Archetypes this image serves, sorted; §4.3 maps several onto one image. */
  readonly archetypes: readonly Archetype[]
  /** Path to its Dockerfile, or null when it does not exist yet (Phase 8). */
  readonly dockerfile: string | null
  /** Build context: the image's own directory. */
  readonly context: string
}

export function imagesRoot(): string {
  return fileURLToPath(new URL('../images', import.meta.url))
}

/** Every base image, in §4.3 order. */
export function baseImages(root = imagesRoot()): ImageDefinition[] {
  return BASE_IMAGES.map((image) => {
    const context = join(root, image)
    const dockerfile = join(context, 'Dockerfile')
    return {
      image,
      archetypes: ARCHETYPES.filter((archetype) => ARCHETYPE_BASE_IMAGE[archetype] === image),
      dockerfile: existsSync(dockerfile) ? dockerfile : null,
      context,
    }
  })
}
