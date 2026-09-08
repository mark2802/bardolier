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
 *
 * A root `discoverProjects` cannot reach no longer stops this (phase 27): its
 * last known ports, from `rootindex.ts`, are folded into the taken set instead
 * of refusing outright. Without even that — a root that has never been
 * indexed — allocation proceeds anyway; the cost of being wrong is a loud
 * `PORT_UNAVAILABLE` at the next `up`, never data loss, unlike a name
 * collision (see `commands/new.ts:requireFreeName`, which stays strict).
 */

import type { Context } from './context.ts'
import { BardolierError } from './errors.ts'
import { discoverProjects, unreadableRoots } from './projects.ts'
import { readRootIndex } from './rootindex.ts'
import { DEV_SERVER_KEY } from './portkeys.ts'
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
 *
 * With more than one root (phase 18), a root that cannot be read folds in its
 * ROOT INDEX instead — the last set of ports it held, per `rootindex.ts`. A
 * root never yet indexed contributes nothing here rather than refusing: see
 * the module header for why that is the right side to be wrong on.
 */
export function assignedPorts(ctx: Context): Map<number, PortHolder> {
  const discovery = discoverProjects(ctx.config)

  const holders = new Map<number, PortHolder>()
  for (const project of discovery.projects) {
    // The dev-server port (§9) is spoken for exactly as a service's is —
    // it lives in the same manifest and must not be handed out twice.
    const appPort = project.manifest.app_port
    if (typeof appPort === 'number' && !holders.has(appPort)) {
      holders.set(appPort, { project: project.name, service: DEV_SERVER_KEY })
    }
    for (const [service, attachment] of Object.entries(project.manifest.services ?? {})) {
      if (typeof attachment?.host_port !== 'number') continue
      // First writer wins: a duplicate means two manifests already collide, and
      // the allocator's job is to avoid both, not to arbitrate between them.
      if (!holders.has(attachment.host_port)) holders.set(attachment.host_port, { project: project.name, service })
    }
    // A named extra port (§5.1) is spoken for exactly as a service's is — same
    // manifest, same "must not be handed out twice" rule.
    for (const [name, attachment] of Object.entries(project.manifest.extra_ports ?? {})) {
      if (typeof attachment?.host_port !== 'number') continue
      if (!holders.has(attachment.host_port)) holders.set(attachment.host_port, { project: project.name, service: name })
    }
  }

  for (const root of unreadableRoots(discovery)) {
    const index = readRootIndex(ctx.loaded.path, root)
    if (!index) continue // never indexed — allocate as if it holds nothing (see module header)
    for (const project of index.projects) {
      for (const port of project.ports) {
        if (!holders.has(port.host_port)) holders.set(port.host_port, { project: project.name, service: port.service })
      }
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
  /** Ports already promised in this same operation but not yet on disk (§9). */
  reserved: Iterable<number> = [],
): Promise<Map<string, number>> {
  const taken = new Set(assignedPorts(ctx).keys())
  for (const port of reserved) taken.add(port)
  const assigned = new Map<string, number>()

  const ordered = [...requests].sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0))
  for (const request of ordered) {
    const port = await allocateOne(ctx, project, request.key, request.definition.host_port_base, taken)
    taken.add(port)
    assigned.set(request.key, port)
  }
  return assigned
}

/**
 * The dev server's host port (§9). Same rules as a service's — start at the
 * archetype's own port and count up, take the first that no manifest claims and
 * no socket holds — so a second web project lands on 3001 rather than failing.
 */
export async function allocateAppPort(
  ctx: Context,
  project: string,
  base: number,
  reserved: Iterable<number> = [],
): Promise<number> {
  const taken = new Set(assignedPorts(ctx).keys())
  for (const port of reserved) taken.add(port)
  return allocateOne(ctx, project, DEV_SERVER_KEY, base, taken)
}

/**
 * A named extra port's host port (§5.1, `port add`). Same rules as the dev
 * server's: no catalogue band to start from, so the search starts at the
 * container port the caller declared and counts up — the number a second
 * `port add --container-port 8081` on this Mac would otherwise collide on.
 */
export async function allocateExtraPort(
  ctx: Context,
  project: string,
  name: string,
  containerPort: number,
  /** Ports already promised in this same operation but not yet on disk — `clone`'s. */
  reserved: Iterable<number> = [],
): Promise<number> {
  const taken = new Set(assignedPorts(ctx).keys())
  for (const port of reserved) taken.add(port)
  return allocateOne(ctx, project, name, containerPort, taken)
}

async function allocateOne(
  ctx: Context,
  project: string,
  key: string,
  base: number,
  taken: ReadonlySet<number>,
): Promise<number> {
  for (let offset = 0; offset < MAX_BAND_SCAN; offset += 1) {
    const port = base + offset
    if (port > MAX_PORT) break
    if (taken.has(port)) continue
    if (await ctx.ports.isFree(port)) return port
  }

  const last = Math.min(base + MAX_BAND_SCAN - 1, MAX_PORT)
  throw new BardolierError(
    'PORT_UNAVAILABLE',
    `No free host port for \`${key}\` in \`${project}\`: ${base}–${last} are all assigned to another project or already bound on this Mac.`,
    { service: key, project, host_port_base: base, scanned: last - base + 1 },
  )
}
