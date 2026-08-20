/**
 * Describing a project's attached services — the read model shared by
 * `service add/remove/list` and `new --services`.
 *
 * Two facts are joined here and nowhere else: the manifest says WHICH services
 * are attached and on which host ports (§4.2), the catalogue says what each one
 * IS (§4.1). Keeping the join in one place is what stops `service list` and
 * `status` from describing the same attachment differently.
 */

import { connectionHint } from './catalogue.ts'
import { attachedKeys, volumeName } from './compose.ts'
import type { AttachedService } from './model/service.ts'
import type { CatalogueService, ServiceCatalogue } from './model/catalogue.ts'
import type { ProjectManifest } from './model/project.ts'

export function describeService(
  project: string,
  key: string,
  definition: CatalogueService,
  hostPort: number,
): AttachedService {
  return {
    key,
    display: definition.display,
    host_port: hostPort,
    container_port: definition.container_port,
    connection_hint: connectionHint(key, definition, hostPort, project),
    volume: volumeName(definition, project),
  }
}

/**
 * Every describable attachment, sorted by key.
 *
 * A key the catalogue no longer defines is omitted rather than rendered with
 * invented values — the same rule `status` follows (§7), and `doctor`'s
 * manifest check is where the discrepancy is reported.
 */
export function attachedServices(manifest: ProjectManifest, catalogue: ServiceCatalogue | null): AttachedService[] {
  const rows: AttachedService[] = []
  for (const key of attachedKeys(manifest)) {
    const definition = catalogue?.services[key]
    const attachment = manifest.services?.[key]
    if (!definition || !attachment) continue
    rows.push(describeService(manifest.name, key, definition, attachment.host_port))
  }
  return rows
}
