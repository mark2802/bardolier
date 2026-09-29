/**
 * `bardolier teardown [--images] [--force]` — `cli-spec.md` §6 (Lifecycle / SSD).
 *
 * The inverse of the README's Install section, minus the one thing that
 * section never promised to be reversible: project data. Order matters —
 * `down-all` runs first, while the config it needs to find every project is
 * still there, then the PATH links and the config directory (config.yml plus
 * the root index — both live beside it) go. Base images are the one part
 * that is NOT default: they are multi-gigabyte but fully re-downloadable
 * (`bardolier build` remakes them from scratch), so removing them is opt-in
 * via `--images` rather than bundled into every teardown.
 *
 * Like `delete` and `volumes rm`, it confirms unless `--force`, and refuses
 * to guess under `--json` with no terminal to ask.
 */

import { existsSync, rmSync } from 'node:fs'
import { dirname } from 'node:path'
import type { Context } from '../context.ts'
import { BardolierError } from '../errors.ts'
import { BASE_IMAGES } from '../model/archetype.ts'
import type { TeardownOutput } from '../model/teardown.ts'
import { conventionalBinDirectories, runUninstall } from '../install.ts'
import { runDownAll } from './ssd.ts'

export type TeardownRequest = {
  readonly images: boolean
  readonly force: boolean
  /** True under `--json`, where there is no way to ask a question (§2). */
  readonly json: boolean
}

function declined(ctx: Context): Promise<TeardownOutput> {
  return ctx.docker.available().then((docker_available) => ({
    confirmed: false,
    stopped: [],
    stray_containers: [],
    docker_available,
    config_dir: dirname(ctx.loaded.path),
    config_removed: false,
    unlinked: [],
    images_removed: [],
  }))
}

/**
 * `binDirs` defaults to the real conventional directories and is overridden
 * only by tests — the same seam `install.ts`'s own mutating functions use,
 * and for the same reason: a test must never be able to unlink a real
 * `bardolier` off the machine running it.
 */
export async function runTeardown(
  ctx: Context,
  request: TeardownRequest,
  binDirs: readonly string[] = conventionalBinDirectories(),
): Promise<TeardownOutput> {
  if (!request.force) {
    if (request.json) {
      throw new BardolierError(
        'INVALID_ARGUMENT',
        'Refusing to tear down without confirmation. Under --json, pass --force.',
      )
    }
    const scope = request.images
      ? 'every bardolier container, the `bardolier`/`bdlr` PATH links, every configured root, and the base images'
      : 'every bardolier container, the `bardolier`/`bdlr` PATH links, and every configured root'
    const confirmed = await ctx.confirm(`Tear down bardolier — stop ${scope}? Project data is never touched.`)
    if (!confirmed) return declined(ctx)
  }

  const down = await runDownAll(ctx)
  const unlinked = runUninstall(binDirs).filter((link) => link.removed)

  const imagesRemoved: string[] = []
  if (request.images && down.docker_available) {
    const present = new Set((await ctx.docker.images()).map((image) => image.repository))
    for (const repository of BASE_IMAGES) {
      if (!present.has(repository)) continue
      await ctx.docker.removeImage(repository, 'latest')
      imagesRemoved.push(repository)
    }
  }

  const configDir = dirname(ctx.loaded.path)
  const configRemoved = existsSync(configDir)
  if (configRemoved) rmSync(configDir, { recursive: true, force: true })

  return {
    confirmed: true,
    stopped: down.stopped,
    stray_containers: down.stray_containers,
    docker_available: down.docker_available,
    config_dir: configDir,
    config_removed: configRemoved,
    unlinked,
    images_removed: imagesRemoved,
  }
}

export function renderTeardown(output: TeardownOutput): string[] {
  if (!output.confirmed) return ['Left everything in place.']

  const lines: string[] = []
  if (!output.docker_available) lines.push('Docker was not running, so nothing was up to stop.')
  else if (output.stopped.length === 0) lines.push('Nothing was running.')
  else lines.push(`Stopped ${output.stopped.length} project(s): ${output.stopped.join(', ')}.`)

  if (output.unlinked.length === 0) lines.push('No `bardolier`/`bdlr` PATH links found to remove.')
  else for (const link of output.unlinked) lines.push(`  Removed ${link.path}`)

  lines.push(
    output.config_removed
      ? `  Removed ${output.config_dir} (config and the root index).`
      : `  ${output.config_dir} did not exist.`,
  )

  if (output.images_removed.length > 0) lines.push(`  Removed base image(s): ${output.images_removed.join(', ')}.`)

  lines.push('Project directories and their data were never touched.')
  return lines
}
