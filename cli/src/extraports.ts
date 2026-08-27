/**
 * Describing a project's declared extra ports — the read model shared by
 * `port add/remove/list`, `status` and compose generation.
 *
 * No catalogue join here, unlike `services.ts`: an extra port has no image, no
 * volume, and no display name to look up — it is entirely the manifest's own
 * `name`/`container_port`/`host_port`, plus the one derived fact (`url`) every
 * caller needs and no caller should compose by hand.
 */

import type { AttachedExtraPort } from './model/extraport.ts'
import type { ProjectExtraPort, ProjectManifest } from './model/project.ts'

/** `http://localhost:<port>` — the one scheme that applies to any of these (§5.1). */
export function extraPortUrl(hostPort: number): string {
  return `http://localhost:${hostPort}`
}

/** Declared extra-port names in a stable (sorted) order — the determinism rule. */
export function extraPortNames(manifest: ProjectManifest): string[] {
  return Object.keys(manifest.extra_ports ?? {}).sort()
}

export function describeExtraPort(name: string, attachment: ProjectExtraPort): AttachedExtraPort {
  return {
    name,
    host_port: attachment.host_port,
    container_port: attachment.container_port,
    url: extraPortUrl(attachment.host_port),
  }
}

/** Every declared extra port, sorted by name. */
export function attachedExtraPorts(manifest: ProjectManifest): AttachedExtraPort[] {
  const rows: AttachedExtraPort[] = []
  for (const name of extraPortNames(manifest)) {
    const attachment = manifest.extra_ports?.[name]
    if (!attachment) continue
    rows.push(describeExtraPort(name, attachment))
  }
  return rows
}
