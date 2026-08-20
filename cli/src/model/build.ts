/**
 * `cproj build` output — `cli-spec.md` §6 (Images).
 *
 * One entry per base image, whether or not it could be built: an archetype
 * whose image is not written yet (ios/android, Phase 8) is reported as
 * `unavailable` rather than silently skipped, so `doctor`'s "base images
 * missing" finding always has a matching explanation here.
 */

import type { Archetype, BaseImage } from './archetype.ts'

export const BUILD_STATUSES = ['built', 'unavailable'] as const
export type BuildStatus = (typeof BUILD_STATUSES)[number]

export type BuiltImage = {
  image: BaseImage
  /** Archetypes served by this image (§4.3 maps several onto one). */
  archetypes: Archetype[]
  status: BuildStatus
  /** Path to the Dockerfile used, or null when none exists yet. */
  dockerfile: string | null
  /** Why it is unavailable; absent on success. */
  reason?: string
}

export type BuildOutput = {
  /** Host UID/GID passed as build args, so files under /work stay owned by the user. */
  uid: number
  gid: number
  /** One entry per image considered, ordered as in §4.3. */
  images: BuiltImage[]
}
