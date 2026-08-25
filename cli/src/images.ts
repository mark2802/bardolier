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
  /** Shared dependency cache this image's toolchain needs, or null. */
  readonly cache: ImageCache | null
}

/**
 * A dependency cache mounted into every dev container built on one image.
 *
 * `volume` is a FIXED name, not a per-project one: the point is that every
 * android project shares one Gradle cache instead of each downloading its own
 * copy of the Android Gradle Plugin. `mount` is an absolute path that does not
 * depend on the host user's home directory — HOST_UID may collide with a user
 * the base image already has, which would move `~`.
 */
export type ImageCache = {
  readonly volume: string
  readonly mount: string
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

/**
 * The one toolchain whose dependency cache is too expensive to keep per project.
 *
 * A Gradle build downloads the Android Gradle Plugin and its transitive world —
 * hundreds of megabytes — before it compiles anything. Kept under the project's
 * bind mount that cost is paid again by every project, and again by every
 * throwaway project a test makes, and it is paid onto the SSD, which is the
 * scarce disk. So it lives in a NAMED VOLUME shared by every `claude-and`
 * container: rebuildable data on the internal disk, like the image layers next
 * to it, while the SSD keeps only what is actually the project's.
 *
 * It is declared HERE, in one place, because three things must agree about it:
 * the Dockerfile's `GRADLE_USER_HOME`, the mount the generated compose file
 * writes, and the volume `up` creates before Compose asks for it. The Dockerfile
 * coupling is asserted in `test/phase8.test.ts` rather than trusted.
 */
export const IMAGE_CACHE: Readonly<Partial<Record<BaseImage, ImageCache>>> = {
  'claude-and': { volume: 'cproj-gradle-cache', mount: '/cache/gradle' },
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
      cache: IMAGE_CACHE[image] ?? null,
    }
  })
}
