/**
 * Container and compose naming — the one place these strings are formed.
 *
 * `status` reads state by matching running containers against these names, and
 * Phase 2's compose generation must emit exactly the same ones. Keeping both
 * sides on this module is what stops a rename in the generator from silently
 * making every project look stopped.
 *
 * The dev container name is fixed by cli-spec.md §7's example: `bardolier-myapp`.
 */

const PREFIX = 'bardolier'

/** Compose project name — also the `com.docker.compose.project` label value. */
export function composeProject(project: string): string {
  return `${PREFIX}-${project}`
}

/** The dev container: `bardolier-myapp` (§7). */
export function devContainerName(project: string): string {
  return `${PREFIX}-${project}`
}

/** A service container: `bardolier-myapp-postgres`. */
export function serviceContainerName(project: string, service: string): string {
  return `${PREFIX}-${project}-${service}`
}

/** True for any container this tool owns; used by `down-all` in Phase 4. */
export function isBardolierContainer(name: string): boolean {
  return name.startsWith(`${PREFIX}-`)
}
