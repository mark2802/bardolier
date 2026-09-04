/**
 * `bardolier build [--archetype <a>] [--claude-code-version <v>]` — `cli-spec.md` §6 (Images).
 *
 * Builds base images with the HOST UID/GID as build args. That is the whole
 * reason this command exists rather than a plain `docker build`: the dev
 * container bind-mounts the project directory, and files it writes must come
 * back owned by the Mac user, not by root.
 *
 * Images live on the INTERNAL disk and are shared across projects (CLAUDE.md,
 * disk frugality) — nothing here writes to the SSD, so `build` works with the
 * SSD unplugged.
 *
 * Claude Code defaults to `latest`, not the Dockerfiles' own pinned ARG:
 * `build` always passes CLAUDE_CODE_VERSION, resolving to the publisher's
 * current release unless `--claude-code-version <X.Y.Z>` asks for an exact
 * one (for reproducing an old image, or isolating a regression to a specific
 * agent build). The Dockerfile resolves and checksum-verifies whichever it
 * gets; `build` itself never talks to the publisher. This is scoped to Claude
 * Code alone — every other pinned toolchain version in these images (Swift,
 * Gradle, the Android SDK, …) stays a fixed ARG, no latest.
 */

import type { Context } from '../context.ts'
import { BardolierError } from '../errors.ts'
import { ARCHETYPES, ARCHETYPE_BASE_IMAGE, isArchetype } from '../model/archetype.ts'
import type { BuildOutput, BuiltImage } from '../model/build.ts'
import { baseImages } from '../images.ts'

/** `latest` (the escape hatch) or a bare `X.Y.Z` release — never a range or a `v` prefix. */
const CLAUDE_CODE_VERSION_PATTERN = /^(latest|\d+\.\d+\.\d+)$/

export async function runBuild(
  ctx: Context,
  archetype: string | undefined,
  claudeCodeVersion?: string,
): Promise<BuildOutput> {
  if (archetype !== undefined && !isArchetype(archetype)) {
    throw new BardolierError('INVALID_ARGUMENT', `Unknown archetype \`${archetype}\`. Expected one of: ${ARCHETYPES.join(', ')}.`)
  }
  if (claudeCodeVersion !== undefined && !CLAUDE_CODE_VERSION_PATTERN.test(claudeCodeVersion)) {
    throw new BardolierError(
      'INVALID_ARGUMENT',
      `Invalid --claude-code-version \`${claudeCodeVersion}\`. Expected \`latest\` or \`X.Y.Z\`.`,
    )
  }

  const wanted = archetype ? ARCHETYPE_BASE_IMAGE[archetype] : null
  const selected = baseImages().filter((definition) => wanted === null || definition.image === wanted)

  if (wanted !== null && selected[0]?.dockerfile === null) {
    // Asked for by name and there is no Dockerfile behind it: say so rather
    // than reporting a successful build of nothing.
    throw new BardolierError(
      'NOT_IMPLEMENTED',
      `The \`${wanted}\` base image has no Dockerfile at ${selected[0]?.context ?? 'its image directory'}.`,
    )
  }

  if (!(await ctx.docker.available())) {
    throw new BardolierError('DOCKER_UNAVAILABLE', 'The Docker daemon did not respond; cannot build base images.')
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

    // Every base image installs Claude Code the same way (§10), so one
    // resolved version applies uniformly; an image without the ARG just
    // ignores an unconsumed build-arg rather than failing.
    const claudeCodePin = claudeCodeVersion ?? 'latest'
    const args: Record<string, string> = {
      HOST_UID: String(uid),
      HOST_GID: String(gid),
      CLAUDE_CODE_VERSION: claudeCodePin,
    }

    await ctx.docker.build({
      tag: `${definition.image}:latest`,
      context: definition.context,
      dockerfile: definition.dockerfile,
      args,
      platform: definition.platform,
    })

    const built: BuiltImage = {
      image: definition.image,
      archetypes: [...definition.archetypes],
      status: 'built',
      dockerfile: definition.dockerfile,
      claudeCodeVersion: claudeCodePin,
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
    const pin = image.claudeCodeVersion ? `, claude-code=${image.claudeCodeVersion}` : ''
    lines.push(
      image.status === 'built'
        ? `✓ ${image.image}:latest  built  (serves: ${serves}${platform}${pin})`
        : `· ${image.image}  skipped  (serves: ${serves}) — ${image.reason ?? 'unavailable'}`,
    )
  }
  return lines
}
