/**
 * Payloads for `deps add | remove | list` — `cli-spec.md` §6 (Deps), §4.2
 * (`extra_packages`); docs/phases/13-extra-packages.md.
 *
 * The shape a service/extra-port attachment would have if there were no host
 * port behind it at all: no catalogue, no volume, no port — just the
 * manifest's own package list plus the one derived fact every caller needs,
 * `image`, so nobody composes `cproj-deps-<base>:<hash>` by hand (`deps.ts`).
 */

export type DepsAddOutput = {
  project: string
  /** The package(s) just declared. */
  added: string[]
  /** Every package declared afterwards, sorted. */
  extra_packages: string[]
  /** The image this project's dev container now builds/runs from. */
  image: string
}

export type DepsRemoveOutput = {
  project: string
  removed: string[]
  /** Every package still declared, sorted. */
  extra_packages: string[]
  image: string
}

export type DepsListOutput = {
  project: string
  extra_packages: string[]
  image: string
}
