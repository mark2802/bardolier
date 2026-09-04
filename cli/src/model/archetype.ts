/**
 * Archetype → base image map. `cli-spec.md` §4.3.
 *
 * Base images carry the per-archetype toolchain only. The map is frozen here
 * because `project.yml` records `base_image` and the app renders `archetype`;
 * whether an image's Dockerfile exists on disk is `images.ts`'s question.
 */

export const ARCHETYPES = ['web', 'ios', 'android', 'library'] as const
export type Archetype = (typeof ARCHETYPES)[number]

export const BASE_IMAGES = ['bardolier-web', 'bardolier-ios', 'bardolier-and'] as const
export type BaseImage = (typeof BASE_IMAGES)[number]

export const ARCHETYPE_BASE_IMAGE: Readonly<Record<Archetype, BaseImage>> = {
  web: 'bardolier-web',
  ios: 'bardolier-ios',
  android: 'bardolier-and',
  library: 'bardolier-web',
}

/**
 * The port an archetype's dev server listens on INSIDE the container, for the
 * archetypes that have one — `cli-spec.md` §9.
 *
 * §9's exception to "the dev container publishes nothing": a web project's dev
 * server is the one thing on it a human needs to reach from the Mac, in a
 * browser, and a browser cannot join the Docker network. So it is treated as a
 * service-like allocation — the number here is both the FIXED container port
 * and the BASE the host-side band counts up from, exactly as a catalogue entry
 * pairs `container_port` with `host_port_base` (§4.1, §5).
 *
 * Fixed inside, variable outside, is what keeps two web projects from clashing
 * while every project's own dev-server config stays identical — the same
 * argument that puts services on `postgres:5432` for every project.
 *
 * An archetype absent here publishes nothing, which is still the default: `ios`
 * and `android` build artefacts rather than serve, and `library` has nothing to
 * open.
 */
export const ARCHETYPE_APP_PORT: Readonly<Partial<Record<Archetype, number>>> = {
  web: 3000,
}

export function isArchetype(value: unknown): value is Archetype {
  return typeof value === 'string' && (ARCHETYPES as readonly string[]).includes(value)
}
