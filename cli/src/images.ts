/**
 * Base images on disk — the other half of the §4.3 archetype map.
 *
 * `model/archetype.ts` says WHICH image an archetype uses; this says whether
 * that image's Dockerfile exists on disk, and on which platform it has to be
 * built and run. "Declared but not written" stays a describable state rather
 * than an error: `build` and `doctor` report it, so a Dockerfile that has not
 * been added yet (or was deleted) is explained rather than crashing the CLI.
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
  /** Path to its Dockerfile, or null when the file does not exist. */
  readonly dockerfile: string | null
  /** Build context: the image's own directory. */
  readonly context: string
  /** Platform the image is pinned to, or null to build and run natively. */
  readonly platform: string | null
}

/**
 * The one image that cannot be built for the machine it runs on.
 *
 * Google publishes the Linux Android SDK build tools — aapt2 above all — for
 * x86_64 only, so on Apple Silicon `claude-and` is built and run emulated. It
 * is pinned HERE, in one place, because `build` and the generated compose file
 * must agree: an image built `linux/amd64` and started without the pin either
 * fails to start or silently pulls a different image. Everything else builds
 * for whatever the Mac is.
 */
export const IMAGE_PLATFORM: Readonly<Partial<Record<BaseImage, string>>> = {
  'claude-and': 'linux/amd64',
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
      platform: IMAGE_PLATFORM[image] ?? null,
    }
  })
}
