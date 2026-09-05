/**
 * `bardolier list` — `cli-spec.md` §6: projects with archetype + running state.
 *
 * Unlike `status`, this one DOES raise SSD_NOT_MOUNTED, as §6 declares. The
 * difference is intentional: `list` answers "what have I got?", a question with
 * no truthful answer while the disk holding the projects is absent, whereas
 * `status` answers "what is the state of the world?", where "SSD unplugged" is
 * itself the answer.
 */

import type { Context } from '../context.ts'
import { BardolierError } from '../errors.ts'
import { collectStatus } from './status.ts'
import type { ListOutput } from '../model/list.ts'

export async function collectList(ctx: Context): Promise<ListOutput> {
  const status = await collectStatus(ctx)
  if (!status.ssd.mounted) {
    throw new BardolierError('SSD_NOT_MOUNTED', `No configured root is readable.`)
  }
  return {
    projects: status.projects.map((project) => ({
      name: project.name,
      archetype: project.archetype,
      state: project.state,
      root: project.root ?? status.ssd.root,
    })),
  }
}

export function renderList(output: ListOutput): string[] {
  if (output.projects.length === 0) return ['No projects.']

  const width = Math.max(...output.projects.map((p) => p.name.length))
  return output.projects.map((p) => `${p.name.padEnd(width, ' ')}  ${p.archetype.padEnd(7, ' ')}  ${p.state}`)
}
