/**
 * Phase 2 — the project lifecycle (new, up, down, delete) and compose
 * generation. No SSD, no daemon. Three properties the rest is built on:
 *   - compose generation is DETERMINISTIC (§9): same manifest, same bytes,
 *     whatever the path, key order, or number of regenerations.
 *   - up/down are IDEMPOTENT (§2) and neither invents state.
 *   - destructive actions are CONSERVATIVE: down keeps data, delete confirms,
 *     --keep-data is the default.
 */

import { test, describe, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { parse as parseYaml } from 'yaml'

import { BardolierError } from '../cli/src/errors.ts'
import { validate } from '../cli/src/schema.ts'
import { COMPOSE_FILENAME, PASSTHROUGH_ENV, attachedKeys, projectVolumes, renderCompose } from '../cli/src/compose.ts'
import { composeProject, devContainerName, serviceContainerName } from '../cli/src/naming.ts'
import { orderManifest, regenerateCompose, renderManifest, requireProject } from '../cli/src/workspace.ts'
import { seededFiles } from '../cli/src/scaffold.ts'
import { baseImages } from '../cli/src/images.ts'
import { runNew } from '../cli/src/commands/new.ts'
import { runUp } from '../cli/src/commands/up.ts'
import { runDown } from '../cli/src/commands/down.ts'
import { runDelete } from '../cli/src/commands/delete.ts'
import { runBuild } from '../cli/src/commands/build.ts'
import { collectStatus } from '../cli/src/commands/status.ts'
import { ARCHETYPES, ARCHETYPE_BASE_IMAGE } from '../cli/src/model/archetype.ts'
import type { Archetype } from '../cli/src/model/archetype.ts'
import type { ProjectManifest } from '../cli/src/model/project.ts'
import type { ServiceCatalogue } from '../cli/src/model/catalogue.ts'
import {
  FIXED_NOW,
  makeContext,
  makeSandbox,
  manifest,
  stubConfirm,
  stubDocker,
  stubPorts,
  type Sandbox,
} from './helpers.ts'

const sandboxes: Sandbox[] = []
function sandbox(): Sandbox {
  const created = makeSandbox()
  sandboxes.push(created)
  return created
}
afterEach(() => {
  while (sandboxes.length > 0) sandboxes.pop()?.cleanup()
})

/** The bundled catalogue, which is what a real run resolves to (§4.1 step 3). */
function catalogue(): ServiceCatalogue {
  return makeContext(sandbox()).catalogue().catalogue
}

/** A manifest with services already attached — Phase 3 assigns these for real. */
function withServices(name = 'myapp'): ProjectManifest {
  return manifest(name, { services: { redis: { host_port: 6380 }, postgres: { host_port: 5433 } } })
}

// ── Compose generation (§9) ───────────────────────────────────────────────────

describe('compose generation (cli-spec.md §9)', () => {
  test('is deterministic: the same manifest renders the same bytes', () => {
    const source = withServices()
    const first = renderCompose({ manifest: source, catalogue: catalogue() })
    const second = renderCompose({ manifest: source, catalogue: catalogue() })
    assert.equal(first, second)
  })

  test('key order in the manifest cannot change the output', () => {
    // The same attachments, declared in the opposite order.
    const forwards = manifest('myapp', { services: { postgres: { host_port: 5433 }, redis: { host_port: 6380 } } })
    const backwards = manifest('myapp', { services: { redis: { host_port: 6380 }, postgres: { host_port: 5433 } } })
    assert.equal(
      renderCompose({ manifest: forwards, catalogue: catalogue() }),
      renderCompose({ manifest: backwards, catalogue: catalogue() }),
    )
  })

  test('regeneration on an unchanged manifest is a no-op write', () => {
    const box = sandbox()
    box.writeProject('myapp', manifest('myapp'))
    const dir = box.path('myapp')

    const first = regenerateCompose(dir, manifest('myapp'), null)
    assert.equal(first.changed, true, 'the first generation writes the file')
    const bytes = readFileSync(first.path, 'utf8')

    const second = regenerateCompose(dir, manifest('myapp'), null)
    assert.equal(second.changed, false, 'a second generation must find nothing to do')
    assert.equal(readFileSync(second.path, 'utf8'), bytes)
  })

  test('a hand-edited compose file is overwritten — project.yml is the truth', () => {
    const box = sandbox()
    box.writeProject('myapp', manifest('myapp'))
    const dir = box.path('myapp')
    regenerateCompose(dir, manifest('myapp'), null)
    writeFileSync(join(dir, COMPOSE_FILENAME), 'services: {evil: {image: nope}}\n')

    const again = regenerateCompose(dir, manifest('myapp'), null)
    assert.equal(again.changed, true)
    assert.ok(!readFileSync(again.path, 'utf8').includes('evil'))
  })

  test('the dev container mounts the project dir at /work and publishes nothing', () => {
    const doc = parseYaml(renderCompose({ manifest: manifest('myapp'), catalogue: null })) as Record<string, any>
    const dev = doc.services.dev
    assert.equal(dev.container_name, devContainerName('myapp'))
    assert.equal(dev.image, 'bardolier-web:latest')
    // The bind mount, then $HOME as a per-project named volume: `down` removes
    // the container, so a home in its writable layer would lose the shell
    // history and the `claude login` on every stop (images.ts, CONTAINER_HOME).
    // Last, the shared `uv` cache every bardolier-web project mounts (Phase 11).
    assert.deepEqual(dev.volumes, ['.:/work', 'bardolier-myapp-home:/state/home', 'bardolier-uv-cache:/cache/uv'])
    assert.equal(dev.working_dir, '/work')
    assert.deepEqual(dev.command, ['sleep', 'infinity'])
    assert.equal(dev.ports, undefined, 'the dev container must not publish host ports')
  })

  test('the bind mount is relative, so where the SSD mounts cannot change the file', () => {
    const rendered = renderCompose({ manifest: manifest('myapp'), catalogue: null })
    assert.ok(!rendered.includes('/Volumes'))
    assert.ok(!rendered.includes('/tmp'))
  })

  test('a bare project on an image with no cache declares exactly one volume: the dev container home', () => {
    // bardolier-ios has no toolchain cache (images.ts); bardolier-web's `uv` cache
    // would otherwise be a second volume here, so this is the one archetype
    // that isolates the claim being tested.
    const ios = manifest('myapp', { archetype: 'ios', base_image: 'bardolier-ios' })
    const doc = parseYaml(renderCompose({ manifest: ios, catalogue: null })) as Record<string, any>
    // Every project has a home volume, so a `volumes:` block is no longer the
    // sign that services are attached — the KEYS are.
    assert.deepEqual(Object.keys(doc.volumes), ['bardolier-myapp-home'])
    assert.equal(doc.volumes['bardolier-myapp-home'].labels['bardolier.role'], 'home')
    assert.equal(doc.volumes['bardolier-myapp-home'].labels['bardolier.project'], 'myapp')
    assert.deepEqual(Object.keys(doc.services), ['dev'])
  })

  test('the dev container inherits the host names it is lent, and no values', () => {
    const doc = parseYaml(renderCompose({ manifest: manifest('myapp'), catalogue: null })) as Record<string, any>
    // Compose's LIST form: a bare name is passed through when the environment
    // running `compose up` has one and left UNSET otherwise. A `NAME=` here
    // would put an empty credential in the container instead of none.
    assert.deepEqual(doc.services.dev.environment, [...PASSTHROUGH_ENV])
    for (const entry of doc.services.dev.environment) {
      assert.ok(!entry.includes('='), `${entry} must not carry a value`)
    }
  })

  test('services publish host:container and carry a named volume (§9)', () => {
    const doc = parseYaml(renderCompose({ manifest: withServices(), catalogue: catalogue() })) as Record<string, any>
    const postgres = doc.services.postgres
    assert.equal(postgres.container_name, serviceContainerName('myapp', 'postgres'))
    assert.equal(postgres.image, 'postgres:17')
    assert.deepEqual(postgres.ports, ['5433:5432'])
    assert.deepEqual(postgres.volumes, ['myapp_pgdata:/var/lib/postgresql/data'])
    assert.deepEqual(doc.volumes.myapp_pgdata.name, 'myapp_pgdata')
  })

  test('{project} is interpolated in env and volume names (§4.1)', () => {
    const doc = parseYaml(renderCompose({ manifest: withServices('shop'), catalogue: catalogue() })) as Record<string, any>
    assert.equal(doc.services.postgres.environment.POSTGRES_DB, 'shop')
    assert.deepEqual(doc.services.postgres.volumes, ['shop_pgdata:/var/lib/postgresql/data'])
  })

  test('one network per project, namespaced by the compose project name', () => {
    const doc = parseYaml(renderCompose({ manifest: manifest('myapp'), catalogue: null })) as Record<string, any>
    assert.equal(doc.name, composeProject('myapp'))
  })

  test('a manifest naming an unknown service fails SERVICE_UNKNOWN, not silence', () => {
    const bad = manifest('myapp', { services: { kafka: { host_port: 9092 } } })
    assert.throws(
      () => renderCompose({ manifest: bad, catalogue: catalogue() }),
      (error: unknown) => error instanceof BardolierError && error.code === 'SERVICE_UNKNOWN',
    )
  })

  test('the generated file warns that it is generated', () => {
    assert.ok(renderCompose({ manifest: manifest('myapp'), catalogue: null }).includes('DO NOT EDIT'))
  })

  test('the manifest round-trips through its own writer without drift', () => {
    const source = withServices()
    const text = renderManifest(source)
    const reparsed = parseYaml(text) as ProjectManifest
    assert.ok(validate('project', reparsed).valid)
    assert.deepEqual(reparsed, parseYaml(renderManifest(reparsed)))
    // Sorted, whatever order the object was built in.
    assert.deepEqual(Object.keys((orderManifest(source).services ?? {}) as object), ['postgres', 'redis'])
  })
})

// ── new (§6, §10) ─────────────────────────────────────────────────────────────

describe('new (cli-spec.md §6, §10)', () => {
  test('creates the manifest, the seeds and the compose file, and validates', async () => {
    const box = sandbox()
    const ctx = makeContext(box)
    const result = await runNew(ctx, { name: 'myapp', archetype: 'web', services: undefined })

    assert.ok(validate('new', result).valid, 'new output must match new.schema.json')
    assert.deepEqual(result.seeded, ['.gitignore', '.dockerignore', 'CLAUDE.md'])
    assert.equal(result.project.base_image, 'bardolier-web')
    assert.equal(result.project.created, FIXED_NOW.toISOString())

    for (const file of ['project.yml', 'docker-compose.yml', '.gitignore', '.dockerignore', 'CLAUDE.md']) {
      assert.ok(box.exists('myapp', file), `new did not write ${file}`)
    }
    const written = parseYaml(box.read('myapp', 'project.yml') ?? '') as ProjectManifest
    assert.ok(validate('project', written).valid)
    assert.equal(written.name, 'myapp')
  })

  test('the new project is immediately visible to status', async () => {
    const box = sandbox()
    const ctx = makeContext(box)
    await runNew(ctx, { name: 'myapp', archetype: 'library', services: undefined })

    const status = await collectStatus(makeContext(box))
    assert.equal(status.projects.length, 1)
    assert.equal(status.projects[0]?.name, 'myapp')
    assert.equal(status.projects[0]?.state, 'stopped')
    assert.equal(status.projects[0]?.dev_container, null)
  })

  test('every archetype produces a manifest whose base_image matches §4.3', async () => {
    for (const archetype of ARCHETYPES) {
      const box = sandbox()
      const result = await runNew(makeContext(box), { name: 'p', archetype, services: undefined })
      assert.equal(result.project.base_image, ARCHETYPE_BASE_IMAGE[archetype])
    }
  })

  test('an existing directory is PROJECT_EXISTS, and is left untouched', async () => {
    const box = sandbox()
    box.writeProject('myapp', manifest('myapp'))
    writeFileSync(box.path('myapp', 'keepme'), 'precious')

    await assert.rejects(
      () => runNew(makeContext(box), { name: 'myapp', archetype: 'web', services: undefined }),
      (error: unknown) => error instanceof BardolierError && error.code === 'PROJECT_EXISTS',
    )
    assert.equal(box.read('myapp', 'keepme'), 'precious')
    assert.ok(!box.exists('myapp', 'CLAUDE.md'), 'a failed new must not seed anything')
  })

  test('an unmounted SSD is SSD_NOT_MOUNTED — never a project on the internal disk', async () => {
    const box = sandbox()
    const ctx = makeContext(box, stubDocker(), { env: { BDLR_SSD_ROOT: join(box.root, 'unplugged') } })
    await assert.rejects(
      () => runNew(ctx, { name: 'myapp', archetype: 'web', services: undefined }),
      (error: unknown) => error instanceof BardolierError && error.code === 'SSD_NOT_MOUNTED',
    )
    assert.ok(!existsSync(join(box.root, 'unplugged')))
  })

  test('rejects a bad archetype and a bad name before touching the disk', async () => {
    const box = sandbox()
    for (const request of [
      { name: 'myapp', archetype: 'toaster', services: undefined },
      { name: 'My App', archetype: 'web', services: undefined },
      { name: '-leading', archetype: 'web', services: undefined },
      { name: '../escape', archetype: 'web', services: undefined },
      { name: undefined, archetype: 'web', services: undefined },
      { name: 'myapp', archetype: undefined, services: undefined },
    ]) {
      await assert.rejects(
        () => runNew(makeContext(box), request),
        (error: unknown) => error instanceof BardolierError && error.code === 'INVALID_ARGUMENT',
        `accepted ${JSON.stringify(request)}`,
      )
    }
  })

  test('a --services request that cannot be honoured creates nothing', async () => {
    // The successful path is Phase 3's (test/phase3.test.ts); what matters here
    // is that a rejected `new` leaves no half-made project behind.
    const box = sandbox()
    await assert.rejects(
      () => runNew(makeContext(box), { name: 'myapp', archetype: 'web', services: 'toaster' }),
      (error: unknown) => error instanceof BardolierError && error.code === 'SERVICE_UNKNOWN',
    )
    assert.ok(!box.exists('myapp'), 'nothing may be created when the request cannot be honoured')
  })

  test('seeded files are archetype-tuned and carry the boundary note (§10)', () => {
    const boundaries: Record<Archetype, string> = {
      web: 'in the container',
      library: 'in the container',
      ios: 'xcodebuild',
      android: 'emulator is host-side',
    }
    for (const archetype of ARCHETYPES) {
      const files = seededFiles('myapp', archetype)
      const claudeMd = files.find((f) => f.name === 'CLAUDE.md')?.contents ?? ''
      assert.ok(claudeMd.includes(boundaries[archetype]), `${archetype} CLAUDE.md lacks its boundary note`)
      // Never localhost: the app talks to services by name over the network (§5).
      assert.ok(claudeMd.includes('postgres:5432'))

      const dockerignore = files.find((f) => f.name === '.dockerignore')?.contents ?? ''
      assert.ok(dockerignore.includes('.git/'), `${archetype} .dockerignore does not exclude .git`)
      assert.ok(dockerignore.includes('node_modules/'))
    }
    assert.ok(seededFiles('myapp', 'ios')[0]?.contents.includes('DerivedData/'))
    assert.ok(seededFiles('myapp', 'android')[0]?.contents.includes('.gradle/'))
  })
})

// ── up (§6, §2, §5) ───────────────────────────────────────────────────────────

describe('up (cli-spec.md §6)', () => {
  test('starts a stopped project and reports what it published', async () => {
    const box = sandbox()
    box.writeProject('myapp', withServices())
    const docker = stubDocker({
      startsAs: [devContainerName('myapp'), serviceContainerName('myapp', 'postgres'), serviceContainerName('myapp', 'redis')],
    })

    const result = await runUp(makeContext(box, docker), { name: 'myapp', noShell: false })

    assert.ok(validate('up', result).valid, 'up output must match up.schema.json')
    assert.equal(result.state, 'running')
    assert.equal(result.already_running, false)
    assert.equal(result.dev_container, devContainerName('myapp'))
    assert.deepEqual(
      result.services.map((s) => [s.key, s.host_port, s.container_port]),
      [
        ['postgres', 5433, 5432],
        ['redis', 6380, 6379],
      ],
    )
    assert.deepEqual(
      docker.calls.map((c) => c.kind),
      // bardolier-web's shared `uv` cache volume (Phase 11) is ensured before `up`.
      ['ensureVolume', 'up'],
    )
  })

  test('regenerates the compose file from the manifest before starting', async () => {
    const box = sandbox()
    box.writeProject('myapp', manifest('myapp'))
    const docker = stubDocker({ startsAs: [devContainerName('myapp')] })

    const result = await runUp(makeContext(box, docker), { name: 'myapp', noShell: false })
    assert.equal(result.compose_regenerated, true)
    assert.ok(box.exists('myapp', COMPOSE_FILENAME))

    const call = docker.calls.find((c) => c.kind === 'up')
    assert.ok(call?.kind === 'up')
    assert.equal(call.target.file, box.path('myapp', COMPOSE_FILENAME))
    assert.equal(call.target.project, composeProject('myapp'))
    assert.equal(call.target.cwd, box.path('myapp'))
  })

  test('a second up on an unchanged project rewrites nothing', async () => {
    const box = sandbox()
    box.writeProject('myapp', manifest('myapp'))
    const dev = devContainerName('myapp')

    await runUp(makeContext(box, stubDocker({ startsAs: [dev] })), { name: 'myapp', noShell: false })
    const second = await runUp(makeContext(box, stubDocker({ running: [dev], startsAs: [dev] })), {
      name: 'myapp',
      noShell: false,
    })
    assert.equal(second.compose_regenerated, false)
  })

  test('is idempotent: up on a running project is a no-op success (§2)', async () => {
    const box = sandbox()
    box.writeProject('myapp', manifest('myapp'))
    const docker = stubDocker({ running: [devContainerName('myapp')] })

    const result = await runUp(makeContext(box, docker), { name: 'myapp', noShell: false })
    assert.equal(result.already_running, true)
    assert.equal(result.state, 'running')
    assert.deepEqual(docker.calls, [], 'a no-op up must not touch Docker')
  })

  test('--no-shell only changes the cue it hands the app; the CLI spawns nothing', async () => {
    const box = sandbox()
    box.writeProject('myapp', manifest('myapp'))
    const dev = devContainerName('myapp')

    const withShell = await runUp(makeContext(box, stubDocker({ startsAs: [dev] })), { name: 'myapp', noShell: false })
    const without = await runUp(makeContext(box, stubDocker({ running: [dev] })), { name: 'myapp', noShell: true })
    assert.equal(withShell.open_shell, true)
    assert.equal(without.open_shell, false)
  })

  test('a squatted host port fails PORT_UNAVAILABLE and names it — never a silent remap (§5)', async () => {
    const box = sandbox()
    box.writeProject('myapp', withServices())
    const docker = stubDocker()
    const ctx = makeContext(box, docker, { ports: stubPorts([5433]) })

    await assert.rejects(
      () => runUp(ctx, { name: 'myapp', noShell: false }),
      (error: unknown) =>
        error instanceof BardolierError &&
        error.code === 'PORT_UNAVAILABLE' &&
        error.message.includes('5433') &&
        error.details?.port === 5433,
    )
    assert.deepEqual(docker.calls, [], 'nothing may start when a port is unavailable')
  })

  test('a port held by this project’s own running service does not block a restart', async () => {
    const box = sandbox()
    box.writeProject('myapp', withServices())
    // postgres is up (so it holds 5433); redis is not.
    const docker = stubDocker({ running: [serviceContainerName('myapp', 'postgres')] })
    const ctx = makeContext(box, docker, { ports: stubPorts([5433]) })

    const result = await runUp(ctx, { name: 'myapp', noShell: false })
    // bardolier-web's shared `uv` cache volume (Phase 11) is ensured, then `up`.
    assert.equal(docker.calls.length, 2)
    assert.equal(result.already_running, false)
  })

  test('reports `partial` honestly when not everything came up', async () => {
    const box = sandbox()
    box.writeProject('myapp', withServices())
    const docker = stubDocker({ startsAs: [devContainerName('myapp'), serviceContainerName('myapp', 'postgres')] })

    const result = await runUp(makeContext(box, docker), { name: 'myapp', noShell: false })
    assert.equal(result.state, 'partial')
  })

  test('an unknown project is PROJECT_NOT_FOUND; an absent SSD is SSD_NOT_MOUNTED', async () => {
    const box = sandbox()
    await assert.rejects(
      () => runUp(makeContext(box), { name: 'ghost', noShell: false }),
      (error: unknown) => error instanceof BardolierError && error.code === 'PROJECT_NOT_FOUND',
    )
    const unplugged = makeContext(box, stubDocker(), { env: { BDLR_SSD_ROOT: join(box.root, 'unplugged') } })
    await assert.rejects(
      () => runUp(unplugged, { name: 'myapp', noShell: false }),
      (error: unknown) => error instanceof BardolierError && error.code === 'SSD_NOT_MOUNTED',
    )
  })

  test('a dead daemon surfaces as DOCKER_UNAVAILABLE', async () => {
    const box = sandbox()
    box.writeProject('myapp', manifest('myapp'))
    await assert.rejects(
      () => runUp(makeContext(box, stubDocker({ available: false })), { name: 'myapp', noShell: false }),
      (error: unknown) => error instanceof BardolierError && error.code === 'DOCKER_UNAVAILABLE',
    )
  })
})

// ── down (§6, §2) ─────────────────────────────────────────────────────────────

describe('down (cli-spec.md §6)', () => {
  test('stops the project and keeps its data', async () => {
    const box = sandbox()
    box.writeProject('myapp', withServices())
    const docker = stubDocker({ running: [devContainerName('myapp')], volumes: ['myapp_pgdata'] })

    const result = await runDown(makeContext(box, docker), 'myapp')
    assert.ok(validate('down', result).valid, 'down output must match down.schema.json')
    assert.equal(result.was_running, true)
    assert.equal(result.state, 'stopped')
    assert.equal(result.data_kept, true)
    // The order is the point (§12): the handoff asks the agent while its
    // container is still up. One `compose down` later there is nobody to ask.
    assert.deepEqual(
      docker.calls.map((c) => c.kind),
      ['exec', 'down'],
    )
    assert.deepEqual(await docker.volumeNames(), ['myapp_pgdata'], 'down must not remove volumes')
    assert.ok(box.exists('myapp', 'project.yml'), 'down must not touch the project directory')
  })

  test('is idempotent: down on a stopped project is a no-op success (§2)', async () => {
    const box = sandbox()
    box.writeProject('myapp', manifest('myapp'))
    const result = await runDown(makeContext(box, stubDocker()), 'myapp')
    assert.equal(result.was_running, false)
    assert.equal(result.state, 'stopped')
  })

  test('regenerates a missing compose file rather than failing', async () => {
    const box = sandbox()
    box.writeProject('myapp', manifest('myapp'))
    assert.ok(!box.exists('myapp', COMPOSE_FILENAME))

    await runDown(makeContext(box, stubDocker()), 'myapp')
    assert.ok(box.exists('myapp', COMPOSE_FILENAME))
  })

  test('up then down leaves the project stopped and the files intact', async () => {
    const box = sandbox()
    box.writeProject('myapp', manifest('myapp'))
    const dev = devContainerName('myapp')
    const docker = stubDocker({ startsAs: [dev] })
    const ctx = makeContext(box, docker)

    await runUp(ctx, { name: 'myapp', noShell: true })
    assert.equal((await collectStatus(ctx, 'myapp')).projects[0]?.state, 'running')

    await runDown(ctx, 'myapp')
    assert.equal((await collectStatus(ctx, 'myapp')).projects[0]?.state, 'stopped')
    assert.ok(box.exists('myapp', 'project.yml'))
  })

  test('an unknown project is PROJECT_NOT_FOUND', async () => {
    const box = sandbox()
    await assert.rejects(
      () => runDown(makeContext(box), 'ghost'),
      (error: unknown) => error instanceof BardolierError && error.code === 'PROJECT_NOT_FOUND',
    )
  })
})

// ── delete (§6, §5) ───────────────────────────────────────────────────────────

describe('delete (cli-spec.md §6)', () => {
  const request = (name: string, overrides: Partial<Parameters<typeof runDelete>[1]> = {}) => ({
    name,
    force: false,
    keepData: false,
    purge: false,
    json: false,
    ...overrides,
  })

  test('brings the project down, removes the dir, and keeps volumes by default', async () => {
    const box = sandbox()
    box.writeProject('myapp', withServices())
    const docker = stubDocker({
      running: [devContainerName('myapp')],
      volumes: ['bardolier-myapp-home', 'myapp_pgdata', 'myapp_redisdata'],
    })

    const result = await runDelete(makeContext(box, docker), request('myapp', { force: true }))

    assert.ok(validate('delete', result).valid, 'delete output must match delete.schema.json')
    assert.equal(result.deleted, true)
    assert.deepEqual(result.released_ports, [5433, 6380])
    assert.deepEqual(result.removed_volumes, [])
    // The dev container's home is kept like any other data volume — a plain
    // delete destroys nothing, so the shell history and the login outlive it.
    assert.deepEqual(result.kept_volumes, ['bardolier-myapp-home', 'myapp_pgdata', 'myapp_redisdata'])
    assert.ok(!box.exists('myapp'), 'the project directory must be gone')
    assert.deepEqual(
      docker.calls.map((c) => c.kind),
      ['down'],
      'delete must stop containers before removing the directory',
    )
    assert.deepEqual(await docker.volumeNames(), ['bardolier-myapp-home', 'myapp_pgdata', 'myapp_redisdata'])
  })

  test('--purge is the only path that destroys volumes', async () => {
    const box = sandbox()
    box.writeProject('myapp', withServices())
    const docker = stubDocker({ volumes: ['bardolier-myapp-home', 'myapp_pgdata', 'myapp_redisdata'] })

    const result = await runDelete(makeContext(box, docker), request('myapp', { force: true, purge: true }))
    assert.deepEqual(result.removed_volumes, ['bardolier-myapp-home', 'myapp_pgdata', 'myapp_redisdata'])
    assert.deepEqual(result.kept_volumes, [])
    assert.deepEqual(await docker.volumeNames(), [])
  })

  test('--purge on a project that was never started still deletes it', async () => {
    const box = sandbox()
    box.writeProject('myapp', withServices())
    // No volumes at all: Compose creates them at `up`, and this project never
    // ran. Asking Docker to remove one that does not exist is an ERROR, so an
    // unfiltered purge would abort after `down` and strand the directory.
    const docker = stubDocker({ volumes: [] })

    const result = await runDelete(makeContext(box, docker), request('myapp', { force: true, purge: true }))

    assert.equal(result.deleted, true)
    assert.deepEqual(result.removed_volumes, [], 'nothing existed, so nothing was removed')
    assert.ok(!box.exists('myapp'), 'the project directory must still be gone')
    assert.deepEqual(
      docker.calls.filter((call) => call.kind === 'removeVolume'),
      [],
      'a volume Docker does not have must never be asked for',
    )
  })

  test('confirms before deleting, and a refusal touches nothing', async () => {
    const box = sandbox()
    box.writeProject('myapp', manifest('myapp'))
    const confirm = stubConfirm(false)
    const docker = stubDocker()

    const result = await runDelete(makeContext(box, docker, { confirm }), request('myapp'))
    assert.equal(result.deleted, false)
    assert.equal(confirm.questions.length, 1)
    assert.ok(box.exists('myapp', 'project.yml'), 'a declined delete must leave the project alone')
    assert.deepEqual(docker.calls, [])
  })

  test('the prompt says whether data is about to be destroyed', async () => {
    const box = sandbox()
    box.writeProject('myapp', withServices())

    const keep = stubConfirm(false)
    await runDelete(makeContext(box, stubDocker(), { confirm: keep }), request('myapp'))
    assert.ok(keep.questions[0]?.includes('kept'), keep.questions[0])

    const purge = stubConfirm(false)
    await runDelete(makeContext(box, stubDocker(), { confirm: purge }), request('myapp', { purge: true }))
    assert.ok(purge.questions[0]?.includes('destroy'), purge.questions[0])
    assert.ok(purge.questions[0]?.includes('myapp_pgdata'))
  })

  test('--force skips the prompt', async () => {
    const box = sandbox()
    box.writeProject('myapp', manifest('myapp'))
    // makeContext's default confirm throws if called at all.
    const result = await runDelete(makeContext(box, stubDocker()), request('myapp', { force: true }))
    assert.equal(result.deleted, true)
  })

  test('under --json, refuses to delete unconfirmed rather than prompting into stdout (§2)', async () => {
    const box = sandbox()
    box.writeProject('myapp', manifest('myapp'))
    await assert.rejects(
      () => runDelete(makeContext(box, stubDocker()), request('myapp', { json: true })),
      (error: unknown) => error instanceof BardolierError && error.code === 'INVALID_ARGUMENT',
    )
    assert.ok(box.exists('myapp', 'project.yml'))
  })

  test('--keep-data and --purge together are refused', async () => {
    const box = sandbox()
    box.writeProject('myapp', manifest('myapp'))
    await assert.rejects(
      () => runDelete(makeContext(box, stubDocker()), request('myapp', { force: true, keepData: true, purge: true })),
      (error: unknown) => error instanceof BardolierError && error.code === 'INVALID_ARGUMENT',
    )
    assert.ok(box.exists('myapp', 'project.yml'))
  })

  test('a volume still in use stops the purge instead of being forced', async () => {
    const box = sandbox()
    box.writeProject('myapp', withServices())
    const docker = stubDocker({ volumes: ['myapp_pgdata'], volumesInUse: ['myapp_pgdata'] })
    await assert.rejects(
      () => runDelete(makeContext(box, docker), request('myapp', { force: true, purge: true })),
      (error: unknown) => error instanceof BardolierError && error.code === 'VOLUME_IN_USE',
    )
    assert.ok(box.exists('myapp', 'project.yml'), 'the directory must survive a failed purge')
  })

  test('releasing ports means the manifest is gone — there is no second registry (§5)', async () => {
    const box = sandbox()
    box.writeProject('myapp', withServices())
    await runDelete(makeContext(box, stubDocker()), request('myapp', { force: true }))

    const status = await collectStatus(makeContext(box))
    assert.deepEqual(status.projects, [])
  })

  test('an unknown project is PROJECT_NOT_FOUND', async () => {
    const box = sandbox()
    await assert.rejects(
      () => runDelete(makeContext(box), request('ghost', { force: true })),
      (error: unknown) => error instanceof BardolierError && error.code === 'PROJECT_NOT_FOUND',
    )
  })
})

// ── build (§6 Images) ─────────────────────────────────────────────────────────

describe('build (cli-spec.md §6, Images)', () => {
  test('builds the web base with the host UID/GID as build args', async () => {
    const box = sandbox()
    const docker = stubDocker()
    const result = await runBuild(makeContext(box, docker), 'web')

    assert.ok(validate('build', result).valid, 'build output must match build.schema.json')
    assert.equal(result.uid, 501)
    assert.equal(result.gid, 20)
    assert.deepEqual(result.images.map((i) => [i.image, i.status]), [['bardolier-web', 'built']])

    const call = docker.calls[0]
    assert.ok(call?.kind === 'build')
    assert.equal(call.request.tag, 'bardolier-web:latest')
    assert.deepEqual(call.request.args, { HOST_UID: '501', HOST_GID: '20', CLAUDE_CODE_VERSION: 'latest' })
    assert.ok(call.request.dockerfile.endsWith(join('bardolier-web', 'Dockerfile')))
  })

  test('`library` shares the web base, per the §4.3 map', async () => {
    const box = sandbox()
    const docker = stubDocker()
    const result = await runBuild(makeContext(box, docker), 'library')
    assert.deepEqual(result.images.map((i) => i.image), ['bardolier-web'])
    assert.deepEqual(result.images[0]?.archetypes, ['web', 'library'])
  })

  test('no argument builds every base image, in §4.3 order', async () => {
    const box = sandbox()
    const result = await runBuild(makeContext(box, stubDocker()), undefined)
    assert.deepEqual(
      result.images.map((i) => [i.image, i.status]),
      [
        ['bardolier-web', 'built'],
        ['bardolier-ios', 'built'],
        ['bardolier-and', 'built'],
      ],
    )
    for (const image of result.images) {
      if (image.status === 'unavailable') assert.ok(image.reason, `${image.image} was skipped without saying why`)
    }
  })

  test('an image with no Dockerfile behind it is described, not thrown away', () => {
    // The state `build` reports as `unavailable`: reachable through the images
    // root, which is what makes a deleted or not-yet-written Dockerfile an
    // explanation rather than a crash.
    const box = sandbox()
    for (const definition of baseImages(join(box.root, 'no-images'))) {
      assert.equal(definition.dockerfile, null)
    }
  })

  test('a dead daemon is DOCKER_UNAVAILABLE, and an unknown archetype is refused', async () => {
    const box = sandbox()
    await assert.rejects(
      () => runBuild(makeContext(box, stubDocker({ available: false })), 'web'),
      (error: unknown) => error instanceof BardolierError && error.code === 'DOCKER_UNAVAILABLE',
    )
    await assert.rejects(
      () => runBuild(makeContext(box, stubDocker()), 'toaster'),
      (error: unknown) => error instanceof BardolierError && error.code === 'INVALID_ARGUMENT',
    )
  })

  test('build works with the SSD unplugged — images live on the internal disk', async () => {
    const box = sandbox()
    const ctx = makeContext(box, stubDocker(), { env: { BDLR_SSD_ROOT: join(box.root, 'unplugged') } })
    const result = await runBuild(ctx, 'web')
    assert.equal(result.images[0]?.status, 'built')
  })

  test('the base image the doctor looks for is the one build produces', () => {
    const web = baseImages().find((image) => image.image === 'bardolier-web')
    assert.ok(web?.dockerfile, 'the bardolier-web Dockerfile is missing from the install')
    const dockerfile = readFileSync(web.dockerfile, 'utf8')
    // The build args are the contract between build.ts and the Dockerfile.
    assert.ok(dockerfile.includes('ARG HOST_UID'))
    assert.ok(dockerfile.includes('ARG HOST_GID'))
    assert.ok(dockerfile.includes('WORKDIR /work'))
  })
})

// ── The lifecycle end to end ──────────────────────────────────────────────────

describe('lifecycle (new → up → down → delete)', () => {
  test('status tracks every transition', async () => {
    const box = sandbox()
    const dev = devContainerName('myapp')
    const docker = stubDocker({ startsAs: [dev] })
    const ctx = makeContext(box, docker, { confirm: stubConfirm(true) })

    await runNew(ctx, { name: 'myapp', archetype: 'web', services: undefined })
    assert.equal((await collectStatus(ctx, 'myapp')).projects[0]?.state, 'stopped')

    await runUp(ctx, { name: 'myapp', noShell: true })
    assert.equal((await collectStatus(ctx, 'myapp')).projects[0]?.state, 'running')
    assert.equal((await collectStatus(ctx, 'myapp')).projects[0]?.dev_container, dev)

    await runDown(ctx, 'myapp')
    assert.equal((await collectStatus(ctx, 'myapp')).projects[0]?.state, 'stopped')

    const deleted = await runDelete(ctx, { name: 'myapp', force: false, keepData: false, purge: false, json: false })
    assert.equal(deleted.deleted, true)
    assert.deepEqual((await collectStatus(ctx)).projects, [])
  })

  test('requireProject is the one gate the mutating commands share', () => {
    const box = sandbox()
    box.writeProject('bad', 'name: [unclosed')
    assert.throws(
      () => requireProject(makeContext(box), 'bad'),
      (error: unknown) => error instanceof BardolierError && error.code === 'CONFIG_INVALID',
    )
    assert.throws(
      () => requireProject(makeContext(box), undefined),
      (error: unknown) => error instanceof BardolierError && error.code === 'INVALID_ARGUMENT',
    )
  })

  test('projectVolumes names exactly what delete --purge would remove', () => {
    // Sorted, and the dev container's home is one of the project's own.
    assert.deepEqual(projectVolumes(withServices('shop'), catalogue()), [
      'bardolier-shop-home',
      'shop_pgdata',
      'shop_redisdata',
    ])
    assert.deepEqual(projectVolumes(manifest('bare'), catalogue()), ['bardolier-bare-home'])
    assert.deepEqual(attachedKeys(withServices()), ['postgres', 'redis'])
  })

  test('a project directory that is not a project is ignored, not clobbered', async () => {
    const box = sandbox()
    mkdirSync(join(box.root, 'notes'), { recursive: true })
    writeFileSync(join(box.root, 'notes', 'todo.md'), 'buy milk')

    const status = await collectStatus(makeContext(box))
    assert.deepEqual(status.projects, [])
    await assert.rejects(
      () => runDown(makeContext(box), 'notes'),
      (error: unknown) => error instanceof BardolierError && error.code === 'PROJECT_NOT_FOUND',
    )
    assert.equal(readFileSync(join(box.root, 'notes', 'todo.md'), 'utf8'), 'buy milk')
  })
})
