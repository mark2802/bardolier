/**
 * The root index — a derived, disposable projection of what one configured
 * root's manifests held, the last time that root was readable.
 * `cli-spec.md` §5, §8; `INTENT.md`'s "Cross-root knowledge while a root is
 * offline" decision. See `rootindex.ts` for what keeps this from becoming a
 * second registry.
 */

import type { Archetype, BaseImage } from './archetype.ts'

export type RootIndexPort = {
  /** A catalogue key, an extra port's name, or `portkeys.ts`'s DEV_SERVER_KEY. */
  service: string
  host_port: number
}

/** Exactly the facts §5/§6 need answered offline — never enough to act on the project. */
export type RootIndexProject = {
  name: string
  archetype: Archetype
  base_image: BaseImage
  /** Every host port this project holds — dev server, services, extra ports. */
  ports: RootIndexPort[]
}

export type RootIndex = {
  root: { name: string; path: string }
  /** ISO 8601 UTC — when this root was last read in full. */
  scanned: string
  projects: RootIndexProject[]
}

/**
 * One unreadable root, and how stale bardolier's last look at it is — the
 * `degraded_roots` a mutating command reports when it had to act (or refuse
 * a name on) a root it could not read, and `status.roots[].last_indexed`.
 */
export type OfflineRoot = {
  root: string
  path: string
  /** ISO 8601 UTC of the last successful scan, or null if it was never indexed. */
  last_indexed: string | null
}
