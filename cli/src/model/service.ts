/**
 * Payloads for `service add | remove | list` — `cli-spec.md` §6 (Services).
 *
 * App-facing contracts like §7's `status`: additive changes only once the app
 * ships (Phase 5+).
 *
 * `AttachedService` is the shared row. It is deliberately Docker-free — key,
 * ports, hint and volume all come from the manifest plus the catalogue — which
 * is why `service list` answers with the daemon down and declares no
 * DOCKER_UNAVAILABLE. Live state belongs to `status` (§7), which has the same
 * fields plus `state`; one shape would have forced this command to query the
 * daemon just to fill a field the caller did not ask for.
 */

export type AttachedService = {
  /** Catalogue key, e.g. `postgres`. */
  key: string
  /** Human label from the catalogue, e.g. `PostgreSQL`. */
  display: string
  /** The debugging tap on the Mac (§5). NOT what the dev app connects to. */
  host_port: number
  /** Fixed port inside the container network — what the dev app connects to. */
  container_port: number
  /** Ready-to-copy string for host GUI tools, e.g. `postgresql://localhost:5433`. */
  connection_hint: string
  /** Named volume holding this service's data, e.g. `myapp_pgdata`. */
  volume: string
}

export type ServiceAddOutput = {
  project: string
  /** The service just attached, with the port it was assigned (§5). */
  added: AttachedService
  /** Every service attached afterwards, sorted by key. */
  services: AttachedService[]
  compose_path: string
  /** False when the regenerated compose file was byte-identical to the old one. */
  compose_regenerated: boolean
}

/**
 * What detaching left behind. `volume` is null only when the catalogue no
 * longer defines the service, in which case its volume name is unknowable —
 * removal still succeeds, because refusing would leave the project unfixable.
 */
export type RemovedService = {
  key: string
  /** The port the project no longer holds; free for the next allocation (§5). */
  host_port: number
  /** KEPT, not destroyed: it becomes a listed orphan (`volumes orphaned`). */
  volume: string | null
}

export type ServiceRemoveOutput = {
  project: string
  removed: RemovedService
  /** Every service still attached, sorted by key. */
  services: AttachedService[]
  compose_path: string
  compose_regenerated: boolean
}

export type ServiceListOutput = {
  project: string
  services: AttachedService[]
}
