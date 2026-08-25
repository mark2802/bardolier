/**
 * `cproj build [--archetype <a>]` — `cli-spec.md` §6 (Images).
 *
 * Builds base images with the HOST UID/GID as build args. That is the whole
 * reason this command exists rather than a plain `docker build`: the dev
 * container bind-mounts the project directory, and files it writes must come
 * back owned by the Mac user, not by root.
 *
 * Images live on the INTERNAL disk and are shared across projects (CLAUDE.md,
 * disk frugality) — nothing here writes to the SSD, so `build` works with the
 * SSD unplugged.
 */

import type { Context } from '../context.ts'
import { CprojError } from '../errors.ts'
import { ARCHETYPES, ARCHETYPE_BASE_IMAGE, isArchetype } from '../model/archetype.ts'
import type { BuildOutput, BuiltImage } from '../model/build.ts'
import { baseImages } from '../images.ts'

export async function runBuild(ctx: Context, archetype: string | undefined): Promise<BuildOutput> {
  if (archetype !== undefined && !isArchetype(archetype)) {
    throw new CprojError('INVALID_ARGUMENT', `Unknown archetype \`${archetype}\`. Expected one of: ${ARCHETYPES.join(', ')}.`)
  }

  const wanted = archetype ? ARCHETYPE_BASE_IMAGE[archetype] : null
  const selected = baseImages().filter((definition) => wanted === null || definition.image === wanted)

  if (wanted !== null && selected[0]?.dockerfile === null) {
    // Asked for by name and there is no Dockerfile behind it: say so rather
    // than reporting a successful build of nothing.
    throw new CprojError(
      'NOT_IMPLEMENTED',
      `The \`${wanted}\` base image has no Dockerfile at ${selected[0]?.context ?? 'its image directory'}.`,
    )
  }

  if (!(await ctx.docker.available())) {
    throw new CprojError('DOCKER_UNAVAILABLE', 'The Docker daemon did not respond; cannot build base images.')
  }

  const { uid, gid } = ctx.host
  const images: BuiltImage[] = []

  for (const definition of selected) {
    if (definition.dockerfile === null) {
      images.push({
        image: definition.image,
        archetypes: [...definition.archetypes],
        status: 'unavailable',
        dockerfile: null,
        reason: `No Dockerfile at ${definition.context}.`,
      })
      continue
    }

    await ctx.docker.build({
      tag: definition.image,
      context: definition.context,
      dockerfile: definition.dockerfile,
      args: { HOST_UID: String(uid), HOST_GID: String(gid) },
      platform: definition.platform,
    })

    const built: BuiltImage = {
      image: definition.image,
      archetypes: [...definition.archetypes],
      status: 'built',
      dockerfile: definition.dockerfile,
    }
    // Reported only where it is true, so the common case says nothing about
    // architecture and the pinned one cannot be missed (`images.ts`).
    if (definition.platform) built.platform = definition.platform
    images.push(built)
  }

  return { uid, gid, images }
}

export function renderBuild(output: BuildOutput): string[] {
  const lines = [`Host identity: uid=${output.uid} gid=${output.gid} (files under /work will be yours)`, '']
  for (const image of output.images) {
    const serves = image.archetypes.join(', ')
    const platform = image.platform ? `, ${image.platform}` : ''
    lines.push(
      image.status === 'built'
        ? `✓ ${image.image}:latest  built  (serves: ${serves}${platform})`
        : `· ${image.image}  skipped  (serves: ${serves}) — ${image.reason ?? 'unavailable'}`,
    )
  }
  return lines
}
