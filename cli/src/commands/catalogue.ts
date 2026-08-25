/**
 * `cproj catalogue` — every service type the catalogue defines (`cli-spec.md`
 * §4.1).
 *
 * Not in §6's original list. It exists because §1 says the app holds no
 * orchestration logic and "if the app needs something, a CLI command grows to
 * provide it": the Services submenu shows every catalogue service with a tick
 * beside the attached ones (`app-spec.md` §6), and the New-project window
 * offers the same list (§8). The only alternative was a second copy of the
 * catalogue in Swift, which is exactly the desync a single editable
 * `services.yml` exists to prevent.
 *
 * READ-ONLY, and Docker-free: catalogue plus nothing. It answers with the
 * daemon down and — when the catalogue resolves to the bundled default — with
 * the SSD unplugged, which is what lets the New-project window open before
 * anything else is ready.
 */

import type { Context } from '../context.ts'
import type { CatalogueOutput } from '../model/catalogue.ts'

export function collectCatalogue(ctx: Context): CatalogueOutput {
  const resolved = ctx.catalogue()
  const services = Object.entries(resolved.catalogue.services)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([key, definition]) => ({
      key,
      display: definition.display,
      image: definition.image,
      container_port: definition.container_port,
      host_port_base: definition.host_port_base,
    }))

  return { path: resolved.path, origin: resolved.origin, services }
}

export function renderCatalogue(output: CatalogueOutput): string[] {
  const lines = [`Service catalogue (${output.origin}): ${output.path}`, '']
  if (output.services.length === 0) {
    return [...lines, 'It defines no services. Add one by editing that file (cli-spec.md §4.1).']
  }
  for (const service of output.services) {
    lines.push(`  ${service.display} (${service.key})`)
    lines.push(`    image ${service.image}   container :${service.container_port}   band from :${service.host_port_base}`)
  }
  lines.push('')
  lines.push('Bands are where allocation STARTS; a project’s actual port lives in its manifest (§5).')
  return lines
}
