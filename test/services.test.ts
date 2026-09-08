/**
 * Attaching and detaching catalogue services.
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { join } from 'node:path'

import { BardolierError } from '../cli/src/errors.ts'
import { validate } from '../cli/src/schema.ts'
import { assignedPorts } from '../cli/src/allocator.ts'
import { attachedServices } from '../cli/src/services.ts'
import { runNew } from '../cli/src/commands/new.ts'
import { runUp } from '../cli/src/commands/up.ts'
import { runDown } from '../cli/src/commands/down.ts'
import { runDelete } from '../cli/src/commands/delete.ts'
import { collectStatus } from '../cli/src/commands/status.ts'
import {
  collectServiceList,
  parseServiceList,
  runServiceAdd,
  runServiceRemove,
} from '../cli/src/commands/service.ts'
import {
  catalogue,
  makeContext,
  manifest,
  ports,
  project,
  readManifest,
  sandboxes,
  stubDocker,
} from './helpers.ts'

const sandbox = sandboxes()

// ── service add (§6) ──────────────────────────────────────────────────────────
describe('service add (cli-spec.md §6)', () => {
  test('records the port, regenerates compose, and reports both', async () => {
    const box = sandbox()
    const ctx = makeContext(box)
    await project(ctx, 'myapp')

    const result = await runServiceAdd(ctx, { project: 'myapp', service: 'postgres' })

    const { valid, errors } = validate('service-add', result)
    assert.ok(valid, `service add output failed its schema:\n${errors.join('\n')}`)
    assert.deepEqual(result.added, {
      key: 'postgres',
      display: 'PostgreSQL',
      host_port: 5432,
      container_port: 5432,
      connection_hint: 'postgresql://localhost:5432',
      data_dir: join(box.root, 'myapp', 'data', 'postgres'),
    })
    assert.equal(result.compose_regenerated, true)
    assert.deepEqual(ports(box, 'myapp'), { postgres: 5432 })

    const compose = box.read('myapp', 'docker-compose.yml') ?? ''
    assert.match(compose, /5432:5432/)
    assert.match(compose, /\.\/data\/postgres:\/var\/lib\/postgresql\/data/)
    assert.match(compose, /container_name: bardolier-myapp-postgres/)
  })

  test('the manifest stays the single source of truth for the port (§4.2)', async () => {
    const box = sandbox()
    const ctx = makeContext(box)
    await project(ctx, 'myapp')
    const result = await runServiceAdd(ctx, { project: 'myapp', service: 'redis' })

    assert.equal(readManifest(box, 'myapp').services?.redis?.host_port, result.added.host_port)
  })

  test('an unknown catalogue key is SERVICE_UNKNOWN and changes nothing', async () => {
    const box = sandbox()
    const ctx = makeContext(box)
    await project(ctx, 'myapp')

    await assert.rejects(
      () => runServiceAdd(ctx, { project: 'myapp', service: 'toaster' }),
      (error: unknown) => error instanceof BardolierError && error.code === 'SERVICE_UNKNOWN',
    )
    assert.deepEqual(ports(box, 'myapp'), {})
  })

  test('adding the same service twice is SERVICE_ATTACHED', async () => {
    const box = sandbox()
    const ctx = makeContext(box)
    await project(ctx, 'myapp')
    await runServiceAdd(ctx, { project: 'myapp', service: 'postgres' })

    await assert.rejects(
      () => runServiceAdd(ctx, { project: 'myapp', service: 'postgres' }),
      (error: unknown) => error instanceof BardolierError && error.code === 'SERVICE_ATTACHED',
    )
    assert.deepEqual(ports(box, 'myapp'), { postgres: 5432 }, 'the first attachment is untouched')
  })

  test('a running project is PROJECT_RUNNING and is left exactly as it was', async () => {
    const box = sandbox()
    const ctx = makeContext(box)
    await project(ctx, 'myapp')
    const before = box.read('myapp', 'docker-compose.yml')

    const running = makeContext(box, stubDocker({ running: ['bardolier-myapp'] }))
    await assert.rejects(
      () => runServiceAdd(running, { project: 'myapp', service: 'postgres' }),
      (error: unknown) => error instanceof BardolierError && error.code === 'PROJECT_RUNNING',
    )
    assert.deepEqual(ports(box, 'myapp'), {})
    assert.equal(box.read('myapp', 'docker-compose.yml'), before)
  })

  test('a partially running project also blocks the change', async () => {
    const box = sandbox()
    const ctx = makeContext(box)
    await project(ctx, 'myapp')
    await runServiceAdd(ctx, { project: 'myapp', service: 'postgres' })

    // Only the service container is up: the project is `partial`, which is
    // exactly the state a mid-flight rewire would make permanent.
    const partial = makeContext(box, stubDocker({ running: ['bardolier-myapp-postgres'] }))
    await assert.rejects(
      () => runServiceAdd(partial, { project: 'myapp', service: 'redis' }),
      (error: unknown) => error instanceof BardolierError && error.code === 'PROJECT_RUNNING',
    )
  })

  test('an unknown project is PROJECT_NOT_FOUND and an absent SSD is SSD_NOT_MOUNTED', async () => {
    const box = sandbox()
    const ctx = makeContext(box)
    await assert.rejects(
      () => runServiceAdd(ctx, { project: 'ghost', service: 'postgres' }),
      (error: unknown) => error instanceof BardolierError && error.code === 'PROJECT_NOT_FOUND',
    )

    const unmounted = makeContext(box, stubDocker(), { env: { BARDOLIER_ROOT: `${box.root}-gone` } })
    await assert.rejects(
      () => runServiceAdd(unmounted, { project: 'myapp', service: 'postgres' }),
      (error: unknown) => error instanceof BardolierError && error.code === 'SSD_NOT_MOUNTED',
    )
  })
})

// ── service remove (§6) ───────────────────────────────────────────────────────
describe('service remove (cli-spec.md §6)', () => {
  test('releases the port, KEEPS the volume, and rewrites compose', async () => {
    const box = sandbox()
    const docker = stubDocker({ volumes: ['myapp_pgdata'] })
    const ctx = makeContext(box, docker)
    await project(ctx, 'myapp')
    await runServiceAdd(ctx, { project: 'myapp', service: 'postgres' })

    const result = await runServiceRemove(ctx, { project: 'myapp', service: 'postgres' })

    const { valid, errors } = validate('service-remove', result)
    assert.ok(valid, `service remove output failed its schema:\n${errors.join('\n')}`)
    assert.deepEqual(result.removed, {
      key: 'postgres',
      host_port: 5432,
      data_dir: join(box.root, 'myapp', 'data', 'postgres'),
    })
    assert.deepEqual(result.services, [])
    assert.deepEqual(ports(box, 'myapp'), {})

    const compose = box.read('myapp', 'docker-compose.yml') ?? ''
    assert.doesNotMatch(compose, /postgres/)
    assert.match(compose, /bardolier-myapp/)

    assert.deepEqual(
      docker.calls.filter((call) => call.kind === 'removeVolume'),
      [],
      'detaching must never destroy data — the volume becomes an orphan',
    )
  })

  test('the released port is handed to the next add (§5)', async () => {
    const box = sandbox()
    const ctx = makeContext(box)
    await project(ctx, 'alpha')
    await project(ctx, 'beta')
    await runServiceAdd(ctx, { project: 'alpha', service: 'postgres' }) // 5432
    await runServiceAdd(ctx, { project: 'beta', service: 'postgres' }) // 5433

    await runServiceRemove(ctx, { project: 'alpha', service: 'postgres' })

    await project(ctx, 'gamma')
    const gamma = await runServiceAdd(ctx, { project: 'gamma', service: 'postgres' })
    assert.equal(gamma.added.host_port, 5432, 'the freed port is reused')
    assert.equal(ports(box, 'beta').postgres, 5433, 'the untouched project keeps its port')
  })

  test('detaching what is not attached is SERVICE_NOT_ATTACHED', async () => {
    const box = sandbox()
    const ctx = makeContext(box)
    await project(ctx, 'myapp')

    await assert.rejects(
      () => runServiceRemove(ctx, { project: 'myapp', service: 'postgres' }),
      (error: unknown) => error instanceof BardolierError && error.code === 'SERVICE_NOT_ATTACHED',
    )
  })

  test('a running project is PROJECT_RUNNING and keeps its port', async () => {
    const box = sandbox()
    const ctx = makeContext(box)
    await project(ctx, 'myapp')
    await runServiceAdd(ctx, { project: 'myapp', service: 'postgres' })

    const running = makeContext(box, stubDocker({ running: ['bardolier-myapp', 'bardolier-myapp-postgres'] }))
    await assert.rejects(
      () => runServiceRemove(running, { project: 'myapp', service: 'postgres' }),
      (error: unknown) => error instanceof BardolierError && error.code === 'PROJECT_RUNNING',
    )
    assert.deepEqual(ports(box, 'myapp'), { postgres: 5432 })
  })

  test('one service can be detached while the others stay put', async () => {
    const box = sandbox()
    const ctx = makeContext(box)
    await runNew(ctx, { name: 'myapp', archetype: 'web', services: 'postgres,redis' })

    const result = await runServiceRemove(ctx, { project: 'myapp', service: 'postgres' })
    assert.deepEqual(result.services.map((s) => s.key), ['redis'])
    assert.deepEqual(ports(box, 'myapp'), { redis: 6379 })
    assert.match(box.read('myapp', 'docker-compose.yml') ?? '', /6379:6379/)
  })
})

// ── service list (§6) ─────────────────────────────────────────────────────────
describe('service list (cli-spec.md §6)', () => {
  test('reports attached services with their resolved ports, sorted', async () => {
    const box = sandbox()
    const ctx = makeContext(box)
    await runNew(ctx, { name: 'myapp', archetype: 'web', services: 'redis,postgres' })

    const result = collectServiceList(ctx, 'myapp')
    const { valid, errors } = validate('service-list', result)
    assert.ok(valid, `service list output failed its schema:\n${errors.join('\n')}`)
    assert.deepEqual(result.services.map((s) => s.key), ['postgres', 'redis'])
    assert.deepEqual(result.services.map((s) => s.host_port), [5432, 6379])
  })

  test('answers with the daemon down — it reads the manifest, not Docker', async () => {
    const box = sandbox()
    const ctx = makeContext(box)
    await runNew(ctx, { name: 'myapp', archetype: 'web', services: 'postgres' })

    // stubDocker(available: false) throws if anything queries it.
    const offline = makeContext(box, stubDocker({ available: false }))
    assert.deepEqual(collectServiceList(offline, 'myapp').services.map((s) => s.key), ['postgres'])
  })

  test('a project with nothing attached lists nothing, and needs no catalogue', async () => {
    const box = sandbox()
    box.writeConfig({ catalogue_path: '/nowhere/services.yml' })
    const ctx = makeContext(box)
    box.writeProject('bare', manifest('bare'))

    assert.deepEqual(collectServiceList(ctx, 'bare'), { project: 'bare', services: [] })
  })

  test('an attachment the catalogue no longer defines is omitted, not invented', () => {
    const box = sandbox()
    const ctx = makeContext(box)
    box.writeProject('myapp', manifest('myapp', { services: { kafka: { host_port: 9092 } } }))

    // Same rule `status` follows (§7): doctor is where the discrepancy is reported.
    assert.deepEqual(collectServiceList(ctx, 'myapp').services, [])
    assert.deepEqual(attachedServices(readManifest(box, 'myapp'), ctx.catalogue().catalogue, box.path('myapp')), [])
  })

  test('an unknown project is PROJECT_NOT_FOUND', () => {
    const box = sandbox()
    const ctx = makeContext(box)
    assert.throws(
      () => collectServiceList(ctx, 'ghost'),
      (error: unknown) => error instanceof BardolierError && error.code === 'PROJECT_NOT_FOUND',
    )
  })
})

// ── new --services (§6) ───────────────────────────────────────────────────────
describe('new --services (cli-spec.md §6)', () => {
  test('attaches and allocates at creation', async () => {
    const box = sandbox()
    const ctx = makeContext(box)

    const result = await runNew(ctx, { name: 'myapp', archetype: 'web', services: 'postgres,redis' })

    const { valid, errors } = validate('new', result)
    assert.ok(valid, `new output failed its schema:\n${errors.join('\n')}`)
    assert.deepEqual(result.services.map((s) => [s.key, s.host_port]), [
      ['postgres', 5432],
      ['redis', 6379],
    ])
    assert.deepEqual(ports(box, 'myapp'), { postgres: 5432, redis: 6379 })

    const compose = box.read('myapp', 'docker-compose.yml') ?? ''
    assert.match(compose, /5432:5432/)
    assert.match(compose, /6379:6379/)
  })

  test('without the flag nothing is attached and the catalogue is never read', async () => {
    const box = sandbox()
    box.writeConfig({ catalogue_path: '/nowhere/services.yml' })
    const ctx = makeContext(box)

    const result = await runNew(ctx, { name: 'myapp', archetype: 'web', services: undefined })
    assert.deepEqual(result.services, [])
  })

  test('an unknown key fails before the directory exists', async () => {
    const box = sandbox()
    const ctx = makeContext(box)

    await assert.rejects(
      () => runNew(ctx, { name: 'myapp', archetype: 'web', services: 'postgres,toaster' }),
      (error: unknown) => error instanceof BardolierError && error.code === 'SERVICE_UNKNOWN',
    )
    assert.ok(!box.exists('myapp'))
  })

  test('duplicates and whitespace in the list are tolerated; an empty list is not', () => {
    assert.deepEqual(parseServiceList(' redis , postgres ,redis'), ['postgres', 'redis'])
    assert.throws(
      () => parseServiceList('  ,, '),
      (error: unknown) => error instanceof BardolierError && error.code === 'INVALID_ARGUMENT',
    )
  })
})

// ── The Phase 3 loop, end to end ──────────────────────────────────────────────
describe('add → up → status → down → remove → delete', () => {
  test('the whole loop keeps one story about ports', async () => {
    const box = sandbox()
    const docker = stubDocker({ startsAs: ['bardolier-myapp', 'bardolier-myapp-postgres'], volumes: ['myapp_pgdata'] })
    const ctx = makeContext(box, docker)

    await project(ctx, 'myapp')
    const added = await runServiceAdd(ctx, { project: 'myapp', service: 'postgres' })
    assert.equal(added.added.host_port, 5432)

    const up = await runUp(ctx, { name: 'myapp', noShell: true })
    assert.equal(up.state, 'running')
    assert.deepEqual(up.services, [{ key: 'postgres', host_port: 5432, container_port: 5432 }])

    const status = await collectStatus(ctx, 'myapp')
    assert.ok(validate('status', status).valid)
    assert.deepEqual(status.projects[0]?.services, [
      {
        key: 'postgres',
        display: 'PostgreSQL',
        state: 'running',
        host_port: 5432,
        container_port: 5432,
        connection_hint: 'postgresql://localhost:5432',
      },
    ])

    await runDown(ctx, 'myapp')
    const removed = await runServiceRemove(ctx, { project: 'myapp', service: 'postgres' })
    assert.equal(removed.removed.data_dir, join(box.root, 'myapp', 'data', 'postgres'))

    const deleted = await runDelete(ctx, {
      name: 'myapp',
      force: true,
      purge: false,
      json: true,
    })
    // The port went with the service, so the project had none left to release.
    assert.deepEqual(deleted.released_ports, [])
    assert.deepEqual(assignedPorts(ctx), new Map())
  })

  test('deleting a project with services attached releases their ports', async () => {
    const box = sandbox()
    const ctx = makeContext(box)
    await runNew(ctx, { name: 'myapp', archetype: 'web', services: 'postgres,redis' })

    const deleted = await runDelete(ctx, { name: 'myapp', force: true, purge: false, json: true })
    assert.deepEqual(deleted.released_ports, [5432, 6379])
    assert.deepEqual(deleted.kept_volumes, [], 'a project owns no named volume since phase 19')

    await project(ctx, 'next')
    const reused = await runServiceAdd(ctx, { project: 'next', service: 'postgres' })
    assert.equal(reused.added.host_port, 5432)
  })
})
