/**
 * Service catalogue — `services.yml`. `cli-spec.md` §4.1.
 *
 * Adding a service type is an edit to this file's YAML, never a code change.
 * Resolution order (§4.1): `catalogue_path` from config, else
 * `$SSD_ROOT/services.yml`, else the bundled default in `cli/defaults/`.
 *
 * `{project}` is interpolated with the project name in `volume` and in `env`
 * values at compose-generation time (§9).
 */

export type CatalogueService = {
  /** Human label, surfaced in `status` and the app's menu. */
  display: string
  image: string
  /** Fixed port inside the container/network — what the dev app connects to. */
  container_port: number
  /** Start of this service's host-port band; the allocator counts up from here (§5). */
  host_port_base: number
  /** Named volume; `{project}` interpolated. */
  volume: string
  /** Container path the volume mounts at. */
  mount: string
  /** Environment for the service container; values may contain `{project}`. */
  env?: Record<string, string>
  /**
   * Optional `status.connection_hint` template (§7), e.g.
   * `postgresql://localhost:{host_port}`. Interpolates `{host_port}`,
   * `{container_port}` and `{project}`. Absent for the bundled services, which
   * fall back to the scheme table in `src/catalogue.ts`; supplying it is what
   * lets a new service type stay a YAML-only addition.
   */
  connection_hint?: string
}

export type ServiceCatalogue = {
  services: Record<string, CatalogueService>
}

/**
 * `bandolier catalogue` output — what the app offers when attaching a service
 * (`app-spec.md` §6) or creating a project (§8).
 *
 * A projection of the file above, not a second definition: `key` is the record
 * key made explicit for an array, and the ports are the DEFINITION's ports.
 * `host_port_base` is where the allocator starts looking (§5), never a port a
 * project holds — that only ever comes from a manifest.
 */
export type CatalogueServiceRow = {
  key: string
  display: string
  image: string
  container_port: number
  /** Start of this service's host-port band (§5). NOT an assigned port. */
  host_port_base: number
}

export type CatalogueOutput = {
  /** The `services.yml` that answered. */
  path: string
  /** Which step of the §4.1 resolution chain it came from. */
  origin: 'config' | 'ssd' | 'bundled'
  /** Every catalogue entry, sorted by key. */
  services: CatalogueServiceRow[]
}
