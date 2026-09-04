/**
 * Catalogue resolution and connection hints — `cli-spec.md` §4.1.
 *
 * Resolution order, first hit wins:
 *   1. `catalogue_path` from config
 *   2. `$SSD_ROOT/services.yml`
 *   3. the bundled `cli/defaults/services.yml`
 *
 * Only an explicitly configured path is an error when missing — the user asked
 * for that file by name. The SSD copy is optional by design, so the CLI still
 * works with the SSD unplugged.
 */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parse as parseYaml } from 'yaml'
import type { Config } from './config.ts'
import { BardolierError } from './errors.ts'
import { assertValid } from './schema.ts'
import type { CatalogueService, ServiceCatalogue } from './model/catalogue.ts'

/** Which step of the §4.1 chain answered. Surfaced by `doctor`. */
export const CATALOGUE_ORIGINS = ['config', 'ssd', 'bundled'] as const
export type CatalogueOrigin = (typeof CATALOGUE_ORIGINS)[number]

export type ResolvedCatalogue = {
  readonly catalogue: ServiceCatalogue
  readonly path: string
  readonly origin: CatalogueOrigin
}

export function bundledCataloguePath(): string {
  return fileURLToPath(new URL('../defaults/services.yml', import.meta.url))
}

function read(path: string): string | null {
  try {
    return readFileSync(path, 'utf8')
  } catch (cause) {
    const code = (cause as NodeJS.ErrnoException).code
    // ENOTDIR/ENOENT cover "SSD unplugged" as well as "file absent".
    if (code === 'ENOENT' || code === 'ENOTDIR') return null
    throw new BardolierError('CONFIG_INVALID', `Cannot read ${path}: ${(cause as Error).message}`)
  }
}

function parseCatalogue(text: string, path: string): ServiceCatalogue {
  let parsed: unknown
  try {
    parsed = parseYaml(text)
  } catch (cause) {
    throw new BardolierError('CONFIG_INVALID', `${path} is not valid YAML: ${(cause as Error).message}`)
  }
  return assertValid<ServiceCatalogue>('services', parsed ?? {}, path)
}

export function resolveCatalogue(config: Config): ResolvedCatalogue {
  if (config.catalogue_path) {
    const text = read(config.catalogue_path)
    if (text === null) {
      throw new BardolierError('CONFIG_INVALID', `catalogue_path points at ${config.catalogue_path}, which does not exist.`)
    }
    return { catalogue: parseCatalogue(text, config.catalogue_path), path: config.catalogue_path, origin: 'config' }
  }

  const onSsd = join(config.ssd_root, 'services.yml')
  const ssdText = read(onSsd)
  if (ssdText !== null) return { catalogue: parseCatalogue(ssdText, onSsd), path: onSsd, origin: 'ssd' }

  const bundled = bundledCataloguePath()
  const bundledText = read(bundled)
  if (bundledText === null) {
    throw new BardolierError('INTERNAL_ERROR', `The bundled catalogue is missing from the install: ${bundled}`)
  }
  return { catalogue: parseCatalogue(bundledText, bundled), path: bundled, origin: 'bundled' }
}

/**
 * URL scheme per catalogue key, used only to build the human-facing
 * `connection_hint` when the catalogue entry doesn't supply a template. It is a
 * cosmetic fallback: an unknown service still gets a usable `tcp://` hint, so
 * "adding a service type is a YAML edit" holds.
 */
const SCHEMES: Readonly<Record<string, string>> = {
  postgres: 'postgresql',
  postgresql: 'postgresql',
  mysql: 'mysql',
  mariadb: 'mysql',
  redis: 'redis',
  mongo: 'mongodb',
  mongodb: 'mongodb',
}

/**
 * The §7 `connection_hint` — a string for the user to paste into a host GUI
 * tool. It names the HOST port deliberately: that port is the debugging tap.
 * The dev app connects over the Docker network by service name instead.
 */
export function connectionHint(
  key: string,
  service: Pick<CatalogueService, 'connection_hint' | 'container_port'>,
  hostPort: number,
  project: string,
): string {
  const template = service.connection_hint ?? `${SCHEMES[key] ?? 'tcp'}://localhost:{host_port}`
  return template
    .replaceAll('{host_port}', String(hostPort))
    .replaceAll('{container_port}', String(service.container_port))
    .replaceAll('{project}', project)
}
