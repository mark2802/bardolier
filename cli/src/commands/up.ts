/**
 * `bardolier up <name> [--no-shell]` — `cli-spec.md` §6 (Projects).
 *
 * Several things happen, in this order, and the order matters:
 *
 *   1. Regenerate the compose file from the manifest. The manifest is the truth
 *      (§4.2); starting from a stale or hand-edited compose file would start
 *      something the manifest does not describe.
 *   2. Build the derived image, when the project declares extra OS packages
 *      (§4.2 `extra_packages`, `deps.ts`) — Compose references a local tag and
 *      never builds it itself. Docker's own build cache makes a repeat `up`
 *      with an unchanged package list cheap, so this runs unconditionally
 *      rather than checking whether the image already exists.
 *   3. Validate every recorded host port is still bindable (§5). A port squatted
 *      while the project was down fails PORT_UNAVAILABLE naming the port — never
 *      a silent remap, which would break saved connection strings.
 *   4. Create the base image's shared toolchain cache volume, if it has one.
 *      The compose file declares it `external` precisely so that Compose does
 *      not claim a volume every android project shares (`images.ts`), which
 *      leaves someone having to make it — and `up` is the only starter.
 *   5. `docker compose up -d`.
 *
 * Idempotent (§2): `up` on a running project is a no-op success. The CLI never
 * spawns a terminal — `open_shell` only tells the app what the user asked for.
 */

import type { Context } from '../context.ts'
import { BardolierError } from '../errors.ts'
import { composeProject, devContainerName, serviceContainerName } from '../naming.ts'
import { attachedKeys, CACHE_VOLUME_LABELS, cacheFor, PASSTHROUGH_ENV } from '../compose.ts'
import { attachedExtraPorts, extraPortNames } from '../extraports.ts'
import { attachedPackages, derivedImageTag, writeDerivedDockerfile } from '../deps.ts'
import { ARCHETYPE_APP_PORT } from '../model/archetype.ts'
import { IMAGE_PLATFORM } from '../images.ts'
import { allocateAppPort } from '../allocator.ts'
import { appUrl } from '../services.ts'
import type { UpOutput, UpService } from '../model/lifecycle.ts'
import type { ProjectManifest } from '../model/project.ts'
import type { ServiceCatalogue } from '../model/catalogue.ts'
import { composePath, observeProject, regenerateCompose, requireProject, writeManifest } from '../workspace.ts'

/** The catalogue is needed only when something is attached (§4.1 chain can fail). */
function catalogueFor(ctx: Context, manifest: ProjectManifest): ServiceCatalogue | null {
  return attachedKeys(manifest).length > 0 ? ctx.catalogue().catalogue : null
}

/**
 * Check the ports we are about to publish. Ports already held by this project's
 * own running containers are skipped — they are "taken" by us, which is the
 * whole point of `up` being idempotent.
 */
async function validatePorts(
  ctx: Context,
  manifest: ProjectManifest,
  alreadyRunning: readonly string[],
  devRunning: boolean,
): Promise<void> {
  // The dev server's port is ours to check too (§9) — unless the dev container
  // is the thing already holding it, which is what makes `up` idempotent.
  if (!devRunning && typeof manifest.app_port === 'number' && !(await ctx.ports.isFree(manifest.app_port))) {
    throw new BardolierError(
      'PORT_UNAVAILABLE',
      `Host port ${manifest.app_port} (the dev server for \`${manifest.name}\`) is already in use. bardolier will not remap it — free the port, or delete \`app_port\` from project.yml to be assigned a new one.`,
      { port: manifest.app_port, project: manifest.name },
    )
  }

  const running = new Set(alreadyRunning)
  for (const key of attachedKeys(manifest)) {
    if (running.has(key)) continue
    const port = manifest.services?.[key]?.host_port
    if (port === undefined) continue
    if (!(await ctx.ports.isFree(port))) {
      throw new BardolierError(
        'PORT_UNAVAILABLE',
        `Host port ${port} (for \`${key}\` in \`${manifest.name}\`) is already in use. bardolier will not remap it — free the port, or remove and re-add the service to assign a new one.`,
        { port, service: key, project: manifest.name },
      )
    }
  }

  // Extra ports (§5.1) live on the dev container, so they follow app_port's
  // rule, not a service's: already-up (devRunning) means WE hold them.
  if (!devRunning) {
    for (const name of extraPortNames(manifest)) {
      const port = manifest.extra_ports?.[name]?.host_port
      if (port === undefined) continue
      if (!(await ctx.ports.isFree(port))) {
        throw new BardolierError(
          'PORT_UNAVAILABLE',
          `Host port ${port} (extra port \`${name}\` in \`${manifest.name}\`) is already in use. bardolier will not remap it — free the port, or remove and re-add it to assign a new one.`,
          { port, name, project: manifest.name },
        )
      }
    }
  }
}

/**
 * The environment `compose up` itself runs with — which is what decides what
 * the dev container inherits (`compose.ts`, PASSTHROUGH_ENV).
 *
 * Two sources, and the caller's wins. Anything already in bardolier's own
 * environment is forwarded as-is; the host's git identity fills in the `GIT_*`
 * names nobody set, so a commit made inside the container is attributed to the
 * human instead of failing on an unset `user.email`. Reading that identity
 * through the seam rather than a config key is deliberate: the human already
 * told git who they are, and a second copy in `config.yml` is a second thing to
 * keep true.
 *
 * A name with no value is OMITTED, never set empty. The generated file lists
 * these in Compose's bare form precisely so an absent token stays absent in the
 * container — an empty `CLAUDE_CODE_OAUTH_TOKEN` is a credential that fails
 * rather than a login prompt.
 */
async function composeEnv(ctx: Context): Promise<Record<string, string>> {
  const env: Record<string, string> = {}
  for (const name of PASSTHROUGH_ENV) {
    const value = ctx.loaded.env[name]
    if (value !== undefined && value.length > 0) env[name] = value
  }

  const identity = await ctx.git.identity()
  if (identity.name !== null) {
    env.GIT_AUTHOR_NAME ??= identity.name
    env.GIT_COMMITTER_NAME ??= identity.name
  }
  if (identity.email !== null) {
    env.GIT_AUTHOR_EMAIL ??= identity.email
    env.GIT_COMMITTER_EMAIL ??= identity.email
  }
  return env
}

/**
 * Build the derived image for this manifest's declared packages, if any —
 * step 2 above. A no-op when `extra_packages` is empty; otherwise the
 * Dockerfile is (re)written deterministically and built, so `composeUp` finds
 * the local tag it references already there.
 */
async function ensureDepsImage(ctx: Context, manifest: ProjectManifest): Promise<void> {
  const packages = attachedPackages(manifest)
  if (packages.length === 0) return
  const { context, dockerfile } = writeDerivedDockerfile(ctx.loaded.path, manifest.base_image, packages, ctx.host.uid, ctx.host.gid)
  await ctx.docker.build({
    tag: derivedImageTag(manifest.base_image, packages),
    context,
    dockerfile,
    args: {},
    platform: IMAGE_PLATFORM[manifest.base_image] ?? null,
  })
}

export type UpRequest = {
  readonly name: string | undefined
  readonly noShell: boolean
}

/**
 * Give a project its dev-server port if its archetype has one and it does not
 * (§9) — the retrofit path for every project created before the field existed.
 *
 * `up` is the right moment and the only one: it is already rewriting the
 * derived file from the manifest, and the assignment then obeys the same rule
 * as every other port — decided ONCE and persisted, never revisited (§5).
 */
async function ensureAppPort(ctx: Context, manifest: ProjectManifest, dir: string): Promise<void> {
  const base = ARCHETYPE_APP_PORT[manifest.archetype]
  if (base === undefined || typeof manifest.app_port === 'number') return
  manifest.app_port = await allocateAppPort(ctx, manifest.name, base)
  writeManifest(dir, manifest)
}

export async function runUp(ctx: Context, request: UpRequest): Promise<UpOutput> {
  const project = requireProject(ctx, request.name)
  const { manifest, dir } = project

  // Before the compose file is rendered from it — the port is one of its inputs.
  await ensureAppPort(ctx, manifest, dir)

  const catalogue = catalogueFor(ctx, manifest)
  const regenerated = regenerateCompose(dir, manifest, catalogue)

  const before = await observeProject(ctx, manifest)
  const alreadyRunning = before.state === 'running'

  if (!alreadyRunning) {
    await ensureDepsImage(ctx, manifest)
    await validatePorts(ctx, manifest, before.runningServices, before.devRunning)
    const cache = cacheFor(manifest)
    if (cache) await ctx.docker.ensureVolume(cache.volume, CACHE_VOLUME_LABELS)
    await ctx.docker.composeUp({
      file: composePath(dir),
      project: composeProject(manifest.name),
      cwd: dir,
      env: await composeEnv(ctx),
    })
  }

  const after = alreadyRunning ? before : await observeProject(ctx, manifest)

  const services: UpService[] = []
  for (const key of attachedKeys(manifest)) {
    const attachment = manifest.services?.[key]
    const definition = catalogue?.services[key]
    if (!attachment || !definition) continue
    services.push({ key, host_port: attachment.host_port, container_port: definition.container_port })
  }

  return {
    project: manifest.name,
    state: after.state,
    dev_container: devContainerName(manifest.name),
    services,
    already_running: alreadyRunning,
    compose_regenerated: regenerated.changed,
    open_shell: !request.noShell,
    app_port: manifest.app_port ?? null,
    app_url: appUrl(manifest) ?? null,
    extra_ports: attachedExtraPorts(manifest),
  }
}

export function renderUp(output: UpOutput): string[] {
  const lines: string[] = []
  lines.push(
    output.already_running
      ? `${output.project} is already up (${output.state}).`
      : `${output.project} is ${output.state}.`,
  )
  lines.push(`  dev container: ${output.dev_container}`)
  if (output.services.length > 0) {
    lines.push('  services:')
    for (const service of output.services) {
      lines.push(`    ${service.key}  host :${service.host_port} → :${service.container_port}`)
    }
  }
  if (output.app_url) lines.push(`  dev server:    ${output.app_url}`)
  for (const port of output.extra_ports ?? []) lines.push(`  ${port.name}:   ${port.url}`)
  if (output.compose_regenerated) lines.push('  (docker-compose.yml regenerated from project.yml)')
  if (output.state !== 'running') {
    lines.push('')
    lines.push(`Not everything came up — run \`bardolier status ${output.project}\` for detail.`)
  } else {
    lines.push('')
    lines.push(`Shell in with: docker exec -it ${output.dev_container} bash`)
  }
  return lines
}

/** Exported for `down`/`delete`, which name the same containers. */
export function containerNames(manifest: ProjectManifest): string[] {
  return [
    devContainerName(manifest.name),
    ...attachedKeys(manifest).map((key) => serviceContainerName(manifest.name, key)),
  ]
}
