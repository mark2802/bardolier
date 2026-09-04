/**
 * Phase 13 — extra packages (docs/phases/13-extra-packages.md): OS-level apt
 * packages a project's toolchain needs beyond its base image, built into a
 * content-addressed derived image at `up` rather than baked into the shared
 * base image or installed at runtime (no root there).
 */

import { test, describe, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { parse as parseYaml } from 'yaml'

import { BardolierError } from '../cli/src/errors.ts'
import { validate } from '../cli/src/schema.ts'
import { composeDocument } from '../cli/src/compose.ts'
import { derivedDockerfile, derivedImageTag, selectedImage } from '../cli/src/deps.ts'
import { runNew } from '../cli/src/commands/new.ts'
import { runUp } from '../cli/src/commands/up.ts'
import { runDown } from '../cli/src/commands/down.ts'
import { collectDepsList, runDepsAdd, runDepsRemove } from '../cli/src/commands/deps.ts'
import type { Context } from '../cli/src/context.ts'
import type { ProjectManifest } from '../cli/src/model/project.ts'
import { makeContext, makeSandbox, manifest, stubDocker, type Sandbox } from './helpers.ts'

const sandboxes: Sandbox[] = []
function sandbox(): Sandbox {
  const created = makeSandbox()
  sandboxes.push(created)
  return created
}
afterEach(() => {
  while (sandboxes.length > 0) sandboxes.pop()?.cleanup()
})

function readManifest(box: Sandbox, project: string): ProjectManifest {
  const text = box.read(project, 'project.yml')
  assert.ok(text, `${project}/project.yml is missing`)
  return parseYaml(text) as ProjectManifest
}

async function project(ctx: Context, name: string): Promise<void> {
  await runNew(ctx, { name, archetype: 'web', services: undefined })
}

// ── the derived-image mechanics (deps.ts) ───────────────────────────────────

describe('derived-image mechanics (deps.ts)', () => {
  test('the tag is content-addressed: same base image + package set → same tag', () => {
    assert.equal(derivedImageTag('bardolier-web', ['libnss3', 'libatk-bridge2.0-0']), derivedImageTag('bardolier-web', ['libatk-bridge2.0-0', 'libnss3']))
  })

  test('a different package set gets a different tag', () => {
    assert.notEqual(derivedImageTag('bardolier-web', ['libnss3']), derivedImageTag('bardolier-web', ['libnss3', 'libatk-bridge2.0-0']))
  })

  test('a different base image gets a different tag for the same packages', () => {
    assert.notEqual(derivedImageTag('bardolier-web', ['libnss3']), derivedImageTag('bardolier-ios', ['libnss3']))
  })

  test('the Dockerfile confines root to image-build time and switches back', () => {
    const text = derivedDockerfile('bardolier-web', ['libnss3'], 501, 20)
    assert.match(text, /^FROM bardolier-web:latest/)
    assert.match(text, /USER root/)
    assert.match(text, /apt-get update && apt-get install -y --no-install-recommends libnss3 && rm -rf \/var\/lib\/apt\/lists\/\*/)
    assert.match(text, /USER 501:20\s*$/)
  })

  test('selectedImage falls back to the plain base image when nothing is declared', () => {
    assert.equal(selectedImage(manifest('myapp')), 'bardolier-web:latest')
  })
})

// ── deps add (§6, §4.2) ──────────────────────────────────────────────────────

describe('deps add (cli-spec.md §6, Deps; §4.2)', () => {
  test('records the package(s), regenerates compose to the derived image, and reports both', async () => {
    const box = sandbox()
    const ctx = makeContext(box)
    await project(ctx, 'myapp')

    const result = await runDepsAdd(ctx, { project: 'myapp', packages: ['libnss3'] })

    const { valid, errors } = validate('deps-add', result)
    assert.ok(valid, `deps add output failed its schema:\n${errors.join('\n')}`)
    assert.deepEqual(result.added, ['libnss3'])
    assert.deepEqual(result.extra_packages, ['libnss3'])
    assert.equal(result.image, derivedImageTag('bardolier-web', ['libnss3']))
    assert.deepEqual(readManifest(box, 'myapp').extra_packages, ['libnss3'])

    const compose = box.read('myapp', 'docker-compose.yml') ?? ''
    assert.match(compose, new RegExp(`image: ${derivedImageTag('bardolier-web', ['libnss3'])}`))
  })

  test('accepts several packages in one call, sorted in the manifest', async () => {
    const box = sandbox()
    const ctx = makeContext(box)
    await project(ctx, 'myapp')

    const result = await runDepsAdd(ctx, { project: 'myapp', packages: ['libnss3', 'libatk-bridge2.0-0'] })
    assert.deepEqual(result.extra_packages, ['libatk-bridge2.0-0', 'libnss3'])
  })

  test('reusing a declared name is PACKAGE_ATTACHED and changes nothing', async () => {
    const box = sandbox()
    const ctx = makeContext(box)
    await project(ctx, 'myapp')
    await runDepsAdd(ctx, { project: 'myapp', packages: ['libnss3'] })

    await assert.rejects(
      () => runDepsAdd(ctx, { project: 'myapp', packages: ['libnss3'] }),
      (error: unknown) => error instanceof BardolierError && error.code === 'PACKAGE_ATTACHED',
    )
    assert.deepEqual(readManifest(box, 'myapp').extra_packages, ['libnss3'])
  })

  test('an unusable package name is INVALID_ARGUMENT', async () => {
    const box = sandbox()
    const ctx = makeContext(box)
    await project(ctx, 'myapp')

    await assert.rejects(
      () => runDepsAdd(ctx, { project: 'myapp', packages: ['Not A Package'] }),
      (error: unknown) => error instanceof BardolierError && error.code === 'INVALID_ARGUMENT',
    )
  })

  test('no packages given is INVALID_ARGUMENT', async () => {
    const box = sandbox()
    const ctx = makeContext(box)
    await project(ctx, 'myapp')

    await assert.rejects(
      () => runDepsAdd(ctx, { project: 'myapp', packages: [] }),
      (error: unknown) => error instanceof BardolierError && error.code === 'INVALID_ARGUMENT',
    )
  })

  test('a running project is PROJECT_RUNNING and is left exactly as it was', async () => {
    const box = sandbox()
    const ctx = makeContext(box)
    await project(ctx, 'myapp')
    const before = box.read('myapp', 'docker-compose.yml')

    const running = makeContext(box, stubDocker({ running: ['bardolier-myapp'] }))
    await assert.rejects(
      () => runDepsAdd(running, { project: 'myapp', packages: ['libnss3'] }),
      (error: unknown) => error instanceof BardolierError && error.code === 'PROJECT_RUNNING',
    )
    assert.equal(box.read('myapp', 'docker-compose.yml'), before)
  })

  test('an unknown project is PROJECT_NOT_FOUND', async () => {
    const box = sandbox()
    const ctx = makeContext(box)
    await assert.rejects(
      () => runDepsAdd(ctx, { project: 'ghost', packages: ['libnss3'] }),
      (error: unknown) => error instanceof BardolierError && error.code === 'PROJECT_NOT_FOUND',
    )
  })

  test('two projects on the same base image with the same package list resolve to the same image tag', async () => {
    const box = sandbox()
    const ctx = makeContext(box)
    await project(ctx, 'alpha')
    await project(ctx, 'beta')

    const alpha = await runDepsAdd(ctx, { project: 'alpha', packages: ['libnss3'] })
    const beta = await runDepsAdd(ctx, { project: 'beta', packages: ['libnss3'] })
    assert.equal(alpha.image, beta.image)
  })
})

// ── deps remove (§6) ─────────────────────────────────────────────────────────

describe('deps remove (cli-spec.md §6, Deps)', () => {
  test('removes the package(s), regenerates compose back to the plain base image', async () => {
    const box = sandbox()
    const ctx = makeContext(box)
    await project(ctx, 'myapp')
    await runDepsAdd(ctx, { project: 'myapp', packages: ['libnss3'] })

    const result = await runDepsRemove(ctx, { project: 'myapp', packages: ['libnss3'] })

    const { valid, errors } = validate('deps-remove', result)
    assert.ok(valid, `deps remove output failed its schema:\n${errors.join('\n')}`)
    assert.deepEqual(result.removed, ['libnss3'])
    assert.deepEqual(result.extra_packages, [])
    assert.equal(result.image, 'bardolier-web:latest')
    assert.equal(readManifest(box, 'myapp').extra_packages, undefined, 'an empty list is omitted, not written empty')

    const compose = box.read('myapp', 'docker-compose.yml') ?? ''
    assert.match(compose, /image: bardolier-web:latest/)
  })

  test('removing what is not declared is PACKAGE_NOT_ATTACHED', async () => {
    const box = sandbox()
    const ctx = makeContext(box)
    await project(ctx, 'myapp')

    await assert.rejects(
      () => runDepsRemove(ctx, { project: 'myapp', packages: ['libnss3'] }),
      (error: unknown) => error instanceof BardolierError && error.code === 'PACKAGE_NOT_ATTACHED',
    )
  })

  test('a running project is PROJECT_RUNNING and keeps its packages', async () => {
    const box = sandbox()
    const ctx = makeContext(box)
    await project(ctx, 'myapp')
    await runDepsAdd(ctx, { project: 'myapp', packages: ['libnss3'] })

    const running = makeContext(box, stubDocker({ running: ['bardolier-myapp'] }))
    await assert.rejects(
      () => runDepsRemove(running, { project: 'myapp', packages: ['libnss3'] }),
      (error: unknown) => error instanceof BardolierError && error.code === 'PROJECT_RUNNING',
    )
    assert.deepEqual(readManifest(box, 'myapp').extra_packages, ['libnss3'])
  })

  test('one package can be removed while another stays put', async () => {
    const box = sandbox()
    const ctx = makeContext(box)
    await project(ctx, 'myapp')
    await runDepsAdd(ctx, { project: 'myapp', packages: ['libnss3', 'libatk-bridge2.0-0'] })

    const result = await runDepsRemove(ctx, { project: 'myapp', packages: ['libnss3'] })
    assert.deepEqual(result.extra_packages, ['libatk-bridge2.0-0'])
  })
})

// ── deps list (§6) ───────────────────────────────────────────────────────────

describe('deps list (cli-spec.md §6, Deps)', () => {
  test('reports declared packages and the resolved image, sorted', async () => {
    const box = sandbox()
    const ctx = makeContext(box)
    await project(ctx, 'myapp')
    await runDepsAdd(ctx, { project: 'myapp', packages: ['libnss3', 'libatk-bridge2.0-0'] })

    const result = collectDepsList(ctx, 'myapp')
    const { valid } = validate('deps-list', result)
    assert.ok(valid)
    assert.deepEqual(result.extra_packages, ['libatk-bridge2.0-0', 'libnss3'])
    assert.equal(result.image, derivedImageTag('bardolier-web', ['libnss3', 'libatk-bridge2.0-0']))
  })

  test('a project with nothing declared lists nothing, no catalogue or daemon needed', async () => {
    const box = sandbox()
    const ctx = makeContext(box, stubDocker({ available: false }))
    await project(ctx, 'myapp')

    assert.deepEqual(collectDepsList(ctx, 'myapp'), { project: 'myapp', extra_packages: [], image: 'bardolier-web:latest' })
  })

  test('an unknown project is PROJECT_NOT_FOUND', () => {
    const box = sandbox()
    const ctx = makeContext(box)
    assert.throws(
      () => collectDepsList(ctx, 'ghost'),
      (error: unknown) => error instanceof BardolierError && error.code === 'PROJECT_NOT_FOUND',
    )
  })
})

// ── compose + up integration ─────────────────────────────────────────────────

describe('extra packages elsewhere in the system', () => {
  test('compose selects the derived image when packages are declared', () => {
    const doc = composeDocument({ manifest: manifest('myapp', { extra_packages: ['libnss3'] }), catalogue: null })
    const services = doc.services as Record<string, { image?: string }>
    assert.equal(services.dev?.image, derivedImageTag('bardolier-web', ['libnss3']))
  })

  test('compose selects the plain base image when nothing is declared', () => {
    const doc = composeDocument({ manifest: manifest('myapp'), catalogue: null })
    const services = doc.services as Record<string, { image?: string }>
    assert.equal(services.dev?.image, 'bardolier-web:latest')
  })

  test('`up` builds the derived image, with no build-args, before composeUp', async () => {
    const box = sandbox()
    const docker = stubDocker()
    const ctx = makeContext(box, docker)
    await project(ctx, 'myapp')
    await runDepsAdd(ctx, { project: 'myapp', packages: ['libnss3'] })

    await runUp(ctx, { name: 'myapp', noShell: true })

    const build = docker.calls.find((call) => call.kind === 'build')
    assert.ok(build, '`up` did not build the derived image')
    assert.ok(build.kind === 'build')
    assert.equal(build.request.tag, derivedImageTag('bardolier-web', ['libnss3']))
    assert.deepEqual(build.request.args, {})

    const buildIndex = docker.calls.indexOf(build)
    const composeUpIndex = docker.calls.findIndex((call) => call.kind === 'up')
    assert.ok(buildIndex < composeUpIndex, 'the image must be built before `compose up`')
  })

  test('a down/up cycle rebuilds (cheaply, via Docker\'s own cache) rather than skipping the build', async () => {
    const box = sandbox()
    const docker = stubDocker()
    const ctx = makeContext(box, docker)
    await project(ctx, 'myapp')
    await runDepsAdd(ctx, { project: 'myapp', packages: ['libnss3'] })

    await runUp(ctx, { name: 'myapp', noShell: true })
    await runDown(ctx, 'myapp')
    await runUp(ctx, { name: 'myapp', noShell: true })

    const builds = docker.calls.filter((call) => call.kind === 'build')
    assert.equal(builds.length, 2)
  })

  test('`up` on an already-running project builds nothing (idempotency)', async () => {
    const box = sandbox()
    const ctx = makeContext(box)
    await project(ctx, 'myapp')
    await runDepsAdd(ctx, { project: 'myapp', packages: ['libnss3'] })

    const docker = stubDocker({ running: ['bardolier-myapp'] })
    const running = makeContext(box, docker)
    await runUp(running, { name: 'myapp', noShell: true })

    assert.equal(docker.calls.filter((call) => call.kind === 'build').length, 0, 'a no-op up must not rebuild the image')
  })
})
