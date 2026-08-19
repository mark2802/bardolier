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
}

export type ServiceCatalogue = {
  services: Record<string, CatalogueService>
}
