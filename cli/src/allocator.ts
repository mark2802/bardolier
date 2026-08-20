/**
 * Host-port allocation — `cli-spec.md` §5, the choosing half. `ports.ts` owns
 * the probe; this module owns the decision.
 *
 * The four §5 requirements map onto the code below one-for-one:
 *
 *   1. UNIQUE     — `assignedPorts` scans every manifest under $SSD_ROOT, not
 *                   just this project's. The manifests ARE the registry (§4.2);
 *                   a second store is the thing that could desync.
 *   2. STABLE     — allocation happens once, at attach time, and the result is
 *                   persisted. Nothing here ever revisits an assigned port; a
 *                   squatted port fails `up` loudly instead of being remapped,
 *                   because the user has connection strings saved against it.
 *   3. EXPOSED    — every attached service gets a host port. There is no
 *                   "internal only" path to fall back to.
 *   4. READABLE   — the search starts at the catalogue's `host_port_base` and
 *                   counts up, so postgres lands in the 543x range and redis in
 *                   the 638x range rather than wherever a global counter got to.
 *
 * A port is free when it is BOTH unassigned in any manifest AND unbound on the
 * host. Checking only the manifests would hand out a port some other Mac app
 * already holds; checking only the socket would hand out a port belonging to a
 * project that happens to be stopped.
 */

import type { Config } from './config.ts'
import type { Context } from './context.ts'
import { CprojError } from './errors.ts'
import { discoverProjects } from './projects.ts'
import type { CatalogueService } from './model/catalogue.ts'

/**
 * How far above the base to look before giving up. Bands are a readability
 * promise (§5.4), so wandering 30,000 ports from the base would honour
 * uniqueness while destroying the property that makes a port guessable.
 */
export const MAX_BAND_SCAN = 512

export const MAX_PORT = 65535

/** Who holds a port, for an error message that names the culprit. */
export type PortHolder = {
  readonly project: string
  readonly service: string
}

/**
 * Every host port currently spoken for, keyed by port (§5 step 2).
 *
 * Projects whose manifest does not parse are absent: their content cannot be
 * trusted enough to reserve a port from, and `doctor`'s manifest check is where
 * that is reported. The host probe is the backstop — if such a project is
 * running, its port is bound and will not be handed out anyway.
 */
export function assignedPorts(config: Config): Map<number, PortHolder> {
  const holders = new Map<number, PortHolder>()
  for (const project of discoverProjects(config).projects) {
    for (const [service, attachment] of Object.entries(project.manifest.services ?? {})) {
      if (typeof attachment?.host_port !== 'number') continue
      // First writer wins: a duplicate means two manifests already collide, and
      // the allocator's job is to avoid both, not to arbitrate between them.
      if (!holders.has(attachment.host_port)) holders.set(attachment.host_port, { project: project.name, service })
    }
  }
  return holders
}

export type PortRequest = {
  /** Catalogue key being attached. */
  readonly key: string
  readonly definition: CatalogueService
}

/**
 * Assign a host port to each request, in one pass over the manifests.
 *
 * Requests are served in sorted key order and each assignment is folded into
 * the taken set, so `--services redis,postgres` and `--services postgres,redis`
 * produce identical manifests — the determinism rule reaching one step further
 * back than compose generation.
 */
export async function allocatePorts(
  ctx: Context,
  project: string,
  requests: readonly PortRequest[],
): Promise<Map<string, number>> {
  const taken = new Set(assignedPorts(ctx.config).keys())
  const assigned = new Map<string, number>()

  const ordered = [...requests].sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0))
  for (const request of ordered) {
    const port = await allocateOne(ctx, project, request, taken)
    taken.add(port)
    assigned.set(request.key, port)
  }
  return assigned
}

async function allocateOne(
  ctx: Context,
  project: string,
  request: PortRequest,
  taken: ReadonlySet<number>,
): Promise<number> {
  const base = request.definition.host_port_base
  for (let offset = 0; offset < MAX_BAND_SCAN; offset += 1) {
    const port = base + offset
    if (port > MAX_PORT) break
    if (taken.has(port)) continue
    if (await ctx.ports.isFree(port)) return port
  }

  const last = Math.min(base + MAX_BAND_SCAN - 1, MAX_PORT)
  throw new CprojError(
    'PORT_UNAVAILABLE',
    `No free host port for \`${request.key}\` in \`${project}\`: ${base}–${last} are all assigned to another project or already bound on this Mac.`,
    { service: request.key, project, host_port_base: base, scanned: last - base + 1 },
  )
}
