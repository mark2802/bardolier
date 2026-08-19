/**
 * The seam between commands and the outside world.
 *
 * A command never reaches for `process.env`, the filesystem root, or `docker`
 * directly — it takes a Context. Production builds one from the real config and
 * a real Docker runner; tests build one pointing at a temp dir with a stubbed
 * runner, which is how Phase 1 is verifiable on a machine with no SSD and no
 * Docker daemon.
 */

import type { Config, LoadOptions, LoadedConfig } from './config.ts'
import { loadConfig } from './config.ts'
import type { Docker } from './docker.ts'
import { createDocker } from './docker.ts'
import type { ResolvedCatalogue } from './catalogue.ts'
import { resolveCatalogue } from './catalogue.ts'

export type Context = {
  readonly loaded: LoadedConfig
  readonly config: Config
  readonly docker: Docker
  /** Deferred: `doctor` must be able to REPORT a broken catalogue, not die of one. */
  readonly catalogue: () => ResolvedCatalogue
}

export type ContextOptions = LoadOptions & {
  readonly docker?: Docker
}

export function createContext(options: ContextOptions = {}): Context {
  const { docker, ...loadOptions } = options
  const loaded = loadConfig(loadOptions)
  let resolved: ResolvedCatalogue | null = null

  return {
    loaded,
    config: loaded.config,
    docker: docker ?? createDocker(),
    catalogue: () => {
      resolved ??= resolveCatalogue(loaded.config)
      return resolved
    },
  }
}
