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
import type { Context } from '../context.ts'
import { WORK_DIR } from '../layout.ts'
import type { EnvOutput } from '../model/env.ts'
import { DOCS_DIR, ENV_DOC, envMd } from '../scaffold.ts'
import { requireProject } from '../workspace.ts'
import { resolveServices } from './service.ts'

export function runEnv(ctx: Context, name: string | undefined, options: { write?: boolean } = {}): EnvOutput {
  const { manifest, dir } = requireProject(ctx, name)
  const keys = Object.keys(manifest.services ?? {})
  const services = keys.length > 0 ? resolveServices(ctx.catalogue().catalogue, keys) : []
  const content = envMd(manifest, services)

  const path = join(dir, WORK_DIR, manifest.name, DOCS_DIR, ENV_DOC)
  const changed = !existsSync(path) || readFileSync(path, 'utf8') !== content
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
