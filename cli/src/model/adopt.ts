/**
 * Payload for `bardolier adopt` — `cli-spec.md` §6 (Projects), phase 30.
 *
 * The mechanical half of `docs/migration-guide.md`'s steps 3-4: create the
 * project and get an existing, external repository into `work/<repo>/`, in
 * one call. Shaped like `NewOutput`/`CloneOutput` on purpose — an adoption
 * IS a new project, plus where its content came from.
 *
 * `--dry-run` reports the same plan with nothing written, EXCEPT a host
 * port: a port is chosen at write time (`allocator.ts`) from whatever is
 * free right then, and can differ between a dry run and the real one if
 * another allocation lands in between. Reporting one here would be exactly
 * the guessed, hand-composed port the migration guide tells its reader never
 * to trust — so `services` is always empty and `manifest_path` etc. are
 * absent under `--dry-run`; `bytes` is still real, since sizing the source is
 * a read-only stat walk with nothing to go stale.
 */

import type { Archetype, BaseImage } from './archetype.ts'
import type { AttachedService } from './service.ts'
import type { OfflineRoot } from './rootindex.ts'

export type AdoptProject = {
  name: string
  archetype: Archetype
  base_image: BaseImage
  /** Absolute path of the project directory — real, or (under --dry-run) prospective. */
  dir: string
  /** The configured root's name this project was (or, under --dry-run, would be) created under. */
  root: string
  /** RFC 3339 UTC timestamp recorded in the manifest. Absent under --dry-run. */
  created?: string
}

export type AdoptSource = {
  /** The path given on the command line, resolved to absolute. */
  path: string
  /** Where it lands (or would land): `<project>/work/<basename>`. */
  dir: string
  basename: string
}

export type AdoptOutput = {
  project: AdoptProject
  /** Absent under --dry-run: nothing was written. */
  manifest_path?: string
  compose_path?: string
  /** File names seeded per §10. Absent under --dry-run. */
  seeded?: string[]
  /** Catalogue keys requested by --services, whether or not yet attached. */
  requested_services: string[]
  /** Attached services with their allocated ports. Empty under --dry-run — see header. */
  services: AttachedService[]
  source: AdoptSource
  /** `move` deletes the source once the copy lands; `copy` (the default) leaves it. */
  mode: 'copy' | 'move'
  /** Bytes under the source directory. Computed by a read-only stat walk, so this is real even under --dry-run. */
  bytes: number
  dry_run: boolean
  /**
   * Present only when a configured root could not be read while this ran
   * (phase 27) — ports were allocated against its last known state. Absent
   * under --dry-run, which allocates nothing.
   */
  degraded_roots?: OfflineRoot[]
}
