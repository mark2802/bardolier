/**
 * `bardolier env <name> [--write]` — `cli-spec.md` §6, §10.
 *
 * `docs/env.md` is seeded once and then drifts as services and ports change.
 * This re-renders it from the manifest. Nothing is written without `--write`:
 * the file may sit inside a repository, and bardolier touches a working tree
 * only when the owner names the command.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { attachedKeys } from '../compose.ts'
import type { Context } from '../context.ts'
import { BardolierError } from '../errors.ts'
import { WORK_DIR, isRenderedEnvMd } from '../layout.ts'
import type { EnvOutput } from '../model/env.ts'
import { DOCS_DIR, ENV_DOC, envMd } from '../scaffold.ts'
import { requireProject } from '../workspace.ts'
import { resolveServices } from './service.ts'

export function runEnv(ctx: Context, name: string | undefined, options: { write?: boolean } = {}): EnvOutput {
  const { manifest, dir } = requireProject(ctx, name)
  const keys = attachedKeys(manifest)
  const services = keys.length > 0 ? resolveServices(ctx.catalogue().catalogue, keys) : []
  const folder = manifest.work_folder
  const content = envMd(manifest, services, folder)

  // Without a recorded folder there is nowhere to write, and none is invented (§10).
  const path = join(dir, WORK_DIR, folder ?? manifest.name, DOCS_DIR, ENV_DOC)
  const current = folder !== undefined && existsSync(path) ? readFileSync(path, 'utf8') : undefined
  const changed = current !== content
  if (options.write && folder === undefined) {
    throw new BardolierError('INVALID_ARGUMENT', `\`${manifest.name}\` has no work_folder in project.yml; add one to use --write.`)
  }
  if (options.write && current !== undefined && !isRenderedEnvMd(current)) {
    throw new BardolierError('INVALID_ARGUMENT', `${path} was not written by bardolier; not overwriting it.`)
  }
  if (options.write && changed) {
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, content)
  }
  return { project: manifest.name, path, content, written: options.write === true, changed }
}

export function renderEnv(output: EnvOutput): string[] {
  if (!output.written) return output.content.replace(/\n$/, '').split('\n')
  return [output.changed ? `Updated ${output.path}` : `${output.path} is already current.`]
}
