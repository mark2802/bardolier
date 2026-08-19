/**
 * `list` output — `cli-spec.md` §6: "array of projects with archetype +
 * running state". A deliberately narrow view of `status` for the cheap case;
 * the app uses `status` for anything richer.
 */

import type { Archetype } from './archetype.ts'
import type { ProjectState } from './status.ts'

export type ListedProject = {
  name: string
  archetype: Archetype
  state: ProjectState
}

export type ListOutput = {
  /** Sorted by name. Empty when the SSD holds no projects. */
  projects: ListedProject[]
}
