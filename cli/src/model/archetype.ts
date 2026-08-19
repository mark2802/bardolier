/**
 * Archetype → base image map. `cli-spec.md` §4.3.
 *
 * Base images carry the per-archetype toolchain only. The `ios` and `android`
 * base images are built in Phase 8; the map is frozen here because
 * `project.yml` records `base_image` and the app renders `archetype`.
 */

export const ARCHETYPES = ['web', 'ios', 'android', 'library'] as const
export type Archetype = (typeof ARCHETYPES)[number]

export const BASE_IMAGES = ['claude-web', 'claude-ios', 'claude-and'] as const
export type BaseImage = (typeof BASE_IMAGES)[number]

export const ARCHETYPE_BASE_IMAGE: Readonly<Record<Archetype, BaseImage>> = {
  web: 'claude-web',
  ios: 'claude-ios',
  android: 'claude-and',
  library: 'claude-web',
}

export function isArchetype(value: unknown): value is Archetype {
  return typeof value === 'string' && (ARCHETYPES as readonly string[]).includes(value)
}
