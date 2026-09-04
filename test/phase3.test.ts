/**
 * Phase 3 — services and port allocation. No SSD, no daemon; the scripted port
 * probe is what makes "the host already holds 5432" a test case rather than a
 * race against this machine. The four §5 requirements:
 *   - UNIQUE across every manifest on the disk, not just this project's.
 *   - STABLE once written down; a squatted port fails loudly, never remaps.
 *   - BANDED from the catalogue's host_port_base.
 *   - RELEASED on remove/delete and reusable.
 * Plus the rule that keeps it simple: add/remove refuse while running, and
 * remove never destroys a volume.
 */

import { test, describe, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { parse as parseYaml } from 'yaml'

import { BardolierError } from '../cli/src/errors.ts'
import { validate } from '../cli/src/schema.ts'
import { MAX_BAND_SCAN, allocatePorts, assignedPorts } from '../cli/src/allocator.ts'
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
import type { Context } from '../cli/src/context.ts'
import type { ProjectManifest } from '../cli/src/model/project.ts'
import { makeContext, makeSandbox, manifest, stubDocker, stubPorts, type Sandbox } from './helpers.ts'

const sandboxes: Sandbox[] = []
function sandbox(): Sandbox {
  const created = makeSandbox()
  sandboxes.push(created)
  return created
}
afterEach(() => {
  while (sandboxes.length > 0) sandboxes.pop()?.cleanup()
})

/** Read what is actually on disk — the manifest is the registry (§4.2, §5). */
function readManifest(box: Sandbox, project: string): ProjectManifest {
  const text = box.read(project, 'project.yml')
  assert.ok(text, `${project}/project.yml is missing`)
  return parseYaml(text) as ProjectManifest
}

function ports(box: Sandbox, project: string): Record<string, number> {
  const services = readManifest(box, project).services ?? {}
  return Object.fromEntries(Object.entries(services).map(([key, value]) => [key, value.host_port]))
}

/** A project on disk, created the way a user would. */
async function project(ctx: Context, name: string, services?: string): Promise<void> {
  await runNew(ctx, { name, archetype: 'web', services })
}

// ── The allocator (§5) ────────────────────────────────────────────────────────

describe('port allocation (cli-spec.md §5)', () => {
  test('scans every manifest on the disk, not just one project (§5 step 2)', () => {
    const box = sandbox()
    box.writeProject('alpha', manifest('alpha', { services: { postgres: { host_port: 5432 } } }))
    box.writeProject('beta', manifest('beta', { services: { postgres: { host_port: 5433 }, redis: { host_port: 6379 } } }))
    const ctx = makeContext(box)

    const held = assignedPorts(ctx.config)
    assert.deepEqual(
      [...held.entries()].sort(([a], [b]) => a - b),
      [
        [5432, { project: 'alpha', service: 'postgres' }],
        [5433, { project: 'beta', service: 'postgres' }],
        [6379, { project: 'beta', service: 'redis' }],
      ],
    )
  })

  test('starts at the catalogue band base (§5.4)', async () => {
    const box = sandbox()
    const ctx = makeContext(box)
    const catalogue = ctx.catalogue().catalogue

    const assigned = await allocatePorts(ctx, 'myapp', [
      { key: 'postgres', definition: catalogue.services.postgres! },
      { key: 'redis', definition: catalogue.services.redis! },
      { key: 'mongo', definition: catalogue.services.mongo! },
    ])
    assert.deepEqual([...assigned], [
      ['mongo', 27017],
      ['postgres', 5432],
      ['redis', 6379],
    ])
  })

  test('is unique across projects: the second postgres lands one above the first', async () => {
    const box = sandbox()
    const ctx = makeContext(box)
    await project(ctx, 'alpha')
    await project(ctx, 'beta')

    await runServiceAdd(ctx, { project: 'alpha', service: 'postgres' })
    await runServiceAdd(ctx, { project: 'beta', service: 'postgres' })

    assert.equal(ports(box, 'alpha').postgres, 5432)
    assert.equal(ports(box, 'beta').postgres, 5433)
  })

  test('skips a port squatted on the host, even though no manifest claims it', async () => {
    const box = sandbox()
    // Two ports held by some other Mac process — TablePlus, a stray container,
    // a local Homebrew postgres. Not ours, so not ours to hand out.
    const ctx = makeContext(box, stubDocker(), { ports: stubPorts([5432, 5433]) })
    await project(ctx, 'myapp')

    const added = await runServiceAdd(ctx, { project: 'myapp', service: 'postgres' })
    assert.equal(added.added.host_port, 5434)
  })

  test('a manifest claim and a host bind are both disqualifying', async () => {
    const box = sandbox()
    const ctx = makeContext(box, stubDocker(), { ports: stubPorts([5433]) })
    await project(ctx, 'alpha')
    await project(ctx, 'beta')

    await runServiceAdd(ctx, { project: 'alpha', service: 'postgres' }) // takes 5432
    const beta = await runServiceAdd(ctx, { project: 'beta', service: 'postgres' })
    assert.equal(beta.added.host_port, 5434, '5432 is claimed and 5433 is bound')
  })

  test('an assigned port is never revisited — adding a second service leaves the first alone', async () => {
    const box = sandbox()
    const ctx = makeContext(box)
    await project(ctx, 'myapp')

    await runServiceAdd(ctx, { project: 'myapp', service: 'postgres' })
    const before = ports(box, 'myapp').postgres
    await runServiceAdd(ctx, { project: 'myapp', service: 'redis' })

    assert.equal(ports(box, 'myapp').postgres, before)
    assert.equal(ports(box, 'myapp').redis, 6379)
  })

  test('ports are stable across stop and start (§5.2)', async () => {
    const box = sandbox()
    const docker = stubDocker({ startsAs: ['bardolier-myapp', 'bardolier-myapp-postgres'] })
    const ctx = makeContext(box, docker)
    await project(ctx, 'myapp')
    await runServiceAdd(ctx, { project: 'myapp', service: 'postgres' })

    const assigned = ports(box, 'myapp').postgres
    await runUp(ctx, { name: 'myapp', noShell: true })
    await runDown(ctx, 'myapp')
    const restarted = await runUp(ctx, { name: 'myapp', noShell: true })

    assert.equal(ports(box, 'myapp').postgres, assigned)
    assert.deepEqual(restarted.services, [{ key: 'postgres', host_port: assigned, container_port: 5432 }])
  })

  test('allocation order does not depend on the order the keys were typed', async () => {
    const box = sandbox()
    const ctx = makeContext(box)
    await runNew(ctx, { name: 'forwards', archetype: 'web', services: 'postgres,redis' })
    await runNew(ctx, { name: 'backwards', archetype: 'web', services: 'redis,postgres' })

    // Different projects, so the second gets the next port in each band — but
    // the KEY→BAND pairing must not flip with the typing order.
    assert.deepEqual(ports(box, 'forwards'), { postgres: 5432, redis: 6379 })
    assert.deepEqual(ports(box, 'backwards'), { postgres: 5433, redis: 6380 })
  })

  test('an exhausted band fails PORT_UNAVAILABLE rather than wandering off it', async () => {
    const box = sandbox()
    // A band with nowhere to go: base 65534, and both candidates bound.
    const cataloguePath = box.writeFile(
      'tight.yml',
      [
        'services:',
        '  tight:',
        '    display: "Tight"',
        '    image: "tight:1"',
        '    container_port: 9000',
        '    host_port_base: 65534',
        '    volume: "{project}_tight"',
        '    mount: /data',
        '',
      ].join('\n'),
    )
    box.writeConfig({ catalogue_path: cataloguePath })
    const ctx = makeContext(box, stubDocker(), { ports: stubPorts([65534, 65535]) })
    await project(ctx, 'myapp')

    await assert.rejects(
      () => runServiceAdd(ctx, { project: 'myapp', service: 'tight' }),
      (error: unknown) => error instanceof BardolierError && error.code === 'PORT_UNAVAILABLE',
    )
    assert.deepEqual(ports(box, 'myapp'), {}, 'a failed allocation must not be recorded')
  })

  test('the band scan is bounded, so allocation cannot walk the whole port space', () => {
    assert.ok(MAX_BAND_SCAN > 0 && MAX_BAND_SCAN <= 1024)
  })
})

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
      volume: 'myapp_pgdata',
    })
    assert.equal(result.compose_regenerated, true)
    assert.deepEqual(ports(box, 'myapp'), { postgres: 5432 })

    const compose = box.read('myapp', 'docker-compose.yml') ?? ''
    assert.match(compose, /5432:5432/)
    assert.match(compose, /myapp_pgdata:\/var\/lib\/postgresql\/data/)
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

    const unmounted = makeContext(box, stubDocker(), { env: { BDLR_SSD_ROOT: `${box.root}-gone` } })
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
    assert.deepEqual(result.removed, { key: 'postgres', host_port: 5432, volume: 'myapp_pgdata' })
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
    assert.deepEqual(attachedServices(readManifest(box, 'myapp'), ctx.catalogue().catalogue), [])
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
    assert.equal(removed.removed.volume, 'myapp_pgdata')

    const deleted = await runDelete(ctx, {
      name: 'myapp',
      force: true,
      keepData: false,
      purge: false,
      json: true,
    })
    // The port went with the service, so the project had none left to release.
    assert.deepEqual(deleted.released_ports, [])
    assert.deepEqual(assignedPorts(ctx.config), new Map())
  })

  test('deleting a project with services attached releases their ports', async () => {
    const box = sandbox()
    const ctx = makeContext(box)
    await runNew(ctx, { name: 'myapp', archetype: 'web', services: 'postgres,redis' })

    const deleted = await runDelete(ctx, { name: 'myapp', force: true, keepData: true, purge: false, json: true })
    assert.deepEqual(deleted.released_ports, [5432, 6379])
    assert.deepEqual(deleted.kept_volumes, ['bardolier-myapp-home', 'myapp_pgdata', 'myapp_redisdata'])

    await project(ctx, 'next')
    const reused = await runServiceAdd(ctx, { project: 'next', service: 'postgres' })
    assert.equal(reused.added.host_port, 5432)
  })
})
