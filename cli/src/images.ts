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
 *
 * `claude-web` carries the same shape of cache for `uv`'s downloaded wheels
 * (docs/phases/11-python-web-toolchain.md) — Python projects migrated onto this
 * archetype pay the same "rebuildable, identical across projects" cost Gradle
 * does, just smaller. `library` shares the image and so shares the cache.
 */
export const IMAGE_CACHE: Readonly<Partial<Record<BaseImage, ImageCache>>> = {
  'claude-web': { volume: 'cproj-uv-cache', mount: '/cache/uv' },
  'claude-and': { volume: 'cproj-gradle-cache', mount: '/cache/gradle' },
}

/**
 * `$HOME` inside every dev container — and a per-project named volume, not a
 * directory in the container layer.
 *
 * `down` removes the container, so a home that lives in its writable layer takes
 * the shell history, the dotfiles, anything installed from a shell, and — since
 * Claude Code keeps its config at `$HOME/.claude` — the login itself. The next
 * `up` would start from nothing every time.
 *
 * Unlike IMAGE_CACHE this is PER PROJECT, and deliberately so. The cache holds
 * rebuildable bytes that are identical everywhere, which is why one copy serves
 * every project; a home holds the user's own state, and — more sharply — it
 * holds Claude Code's session transcripts, which are filed by working directory.
 * Every dev container works in `/work`, so a single shared home would file every
 * project's sessions under one key and `claude --continue` would resume
 * whichever project ran last. One home per project is what keeps that honest.
 *
 * The value is fixed rather than derived from the image's own user because
 * HOST_UID may collide with a user the base image already ships, which moves
 * `~` — and compose cannot mount a volume at a path it cannot predict. All
 * three Dockerfiles set `ENV HOME` to this and must agree with it
 * (`test/phase9.test.ts`).
 */
export const CONTAINER_HOME = '/state/home'

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
