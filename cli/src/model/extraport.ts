/**
 * Payloads for `port add | remove | list` — `cli-spec.md` §6 (Ports), §5.1.
 *
 * The shape a service attachment would have if there were no catalogue behind
 * it: no `display`, no `volume`, no `connection_hint` built from a protocol
 * the catalogue named — just the name the caller chose and the two ports.
 * `url` stands in for `connection_hint`: every extra port is a thing you point
 * a browser or a native client at, so `http://localhost:<host_port>` is the
 * one hint that always applies, unlike a service's protocol-specific string.
 */

import type { OfflineRoot } from './rootindex.ts'

export type AttachedExtraPort = {
  /** The caller's own name, e.g. `metro`, `notebook`. Not a catalogue key. */
  name: string
  /** The debugging-tap-turned-real-address on the Mac (§5.1). */
  host_port: number
  /** Fixed port inside the container — what `--container-port` declared. */
  container_port: number
  /** `http://localhost:<host_port>`, ready to open or hand to a native client. */
  url: string
}

export type PortAddOutput = {
  project: string
  /** The port just declared, with the host port the allocator assigned it. */
  added: AttachedExtraPort
  /** Every extra port declared afterwards, sorted by name. */
  extra_ports: AttachedExtraPort[]
  compose_path: string
  /** False when the regenerated compose file was byte-identical to the old one. */
  compose_regenerated: boolean
  /** Present only when a configured root could not be read while this ran. */
  degraded_roots?: OfflineRoot[]
}

export type RemovedExtraPort = {
  name: string
  /** The port the project no longer holds; free for the next allocation (§5). */
  host_port: number
}

export type PortRemoveOutput = {
  project: string
  removed: RemovedExtraPort
  /** Every extra port still declared, sorted by name. */
  extra_ports: AttachedExtraPort[]
  compose_path: string
  compose_regenerated: boolean
}

export type PortListOutput = {
  project: string
  extra_ports: AttachedExtraPort[]
}
