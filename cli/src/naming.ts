/**
 * Container and compose naming — the one place these strings are formed.
 *
 * `status` reads state by matching running containers against these names, and
 * Phase 2's compose generation must emit exactly the same ones. Keeping both
 * sides on this module is what stops a rename in the generator from silently
 * making every project look stopped.
 *
 * The dev container name is fixed by cli-spec.md §7's example: `bandolier-myapp`.
 */

const PREFIX = 'bandolier'

/** Compose project name — also the `com.docker.compose.project` label value. */
export function composeProject(project: string): string {
  return `${PREFIX}-${project}`
}

/** The dev container: `bandolier-myapp` (§7). */
export function devContainerName(project: string): string {
  return `${PREFIX}-${project}`
}

/** A service container: `bandolier-myapp-postgres`. */
export function serviceContainerName(project: string, service: string): string {
  return `${PREFIX}-${project}-${service}`
}

/**
 * The dev container's persistent `$HOME` volume: `bandolier-myapp-home`.
 *
 * Named here with everything else so the generator, the orphan scan and
 * `delete --purge` cannot disagree about what it is called. It shares the
 * service-container shape but can never collide with one: a catalogue key is a
 * service, and `home` is not something the catalogue may define
 * (`test/phase9.test.ts`).
 */
export function homeVolumeName(project: string): string {
  return `${PREFIX}-${project}-home`
}

/** True for any container this tool owns; used by `down-all` in Phase 4. */
export function isBandolierContainer(name: string): boolean {
  return name.startsWith(`${PREFIX}-`)
}
