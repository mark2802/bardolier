/**
 * Port allocation (§5) and the named extra ports declared on top of it (§5.1).
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { join } from 'node:path'
import { rmSync } from 'node:fs'

import { BardolierError } from '../cli/src/errors.ts'
import { validate } from '../cli/src/schema.ts'
import { MAX_BAND_SCAN, allocatePorts, assignedPorts } from '../cli/src/allocator.ts'
import { runNew } from '../cli/src/commands/new.ts'
import { runUp } from '../cli/src/commands/up.ts'
import { runDown } from '../cli/src/commands/down.ts'
import { runDelete } from '../cli/src/commands/delete.ts'
import { collectStatus } from '../cli/src/commands/status.ts'
import { runServiceAdd } from '../cli/src/commands/service.ts'
import { composeDocument } from '../cli/src/compose.ts'
import { collectPortList, runPortAdd, runPortRemove } from '../cli/src/commands/port.ts'
import { scanVolumes } from '../cli/src/volumes.ts'
import {
  catalogue,
  makeContext,
  manifest,
  ports,
  project,
  readManifest,
  sandboxes,
  stubDocker,
  stubPorts,
  tempDirs,
  twoRoots,
} from './helpers.ts'

const sandbox = sandboxes()
const secondRoot = tempDirs('bardolier-root-b-')

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

// ── port add (§6, §5.1) ────────────────────────────────────────────────────────
describe('port add (cli-spec.md §6, Ports; §5.1)', () => {
  test('records the port, regenerates compose, and reports both', async () => {
    const box = sandbox()
    const ctx = makeContext(box)
    await project(ctx, 'myapp')

    const result = await runPortAdd(ctx, { project: 'myapp', name: 'notebook', containerPort: '8888' })

    const { valid, errors } = validate('port-add', result)
    assert.ok(valid, `port add output failed its schema:\n${errors.join('\n')}`)
    assert.deepEqual(result.added, {
      name: 'notebook',
      host_port: 8888,
      container_port: 8888,
      url: 'http://localhost:8888',
    })
    assert.equal(result.compose_regenerated, true)
    assert.equal(readManifest(box, 'myapp').extra_ports?.notebook?.host_port, 8888)

    const compose = box.read('myapp', 'docker-compose.yml') ?? ''
    assert.match(compose, /8888:8888/)
  })

  test('the search starts at --container-port and counts up, independent of any catalogue band', async () => {
    const box = sandbox()
    const ctx = makeContext(box, stubDocker(), { ports: stubPorts([8888]) })
    await project(ctx, 'myapp')

    const result = await runPortAdd(ctx, { project: 'myapp', name: 'notebook', containerPort: '8888' })
    assert.equal(result.added.host_port, 8889)
  })

  test('a second project on the same container port lands one above the first (§5 uniqueness)', async () => {
    const box = sandbox()
    const ctx = makeContext(box)
    await project(ctx, 'alpha')
    await project(ctx, 'beta')

    await runPortAdd(ctx, { project: 'alpha', name: 'notebook', containerPort: '8888' })
    const beta = await runPortAdd(ctx, { project: 'beta', name: 'notebook', containerPort: '8888' })
    assert.equal(beta.added.host_port, 8889)
  })

  test('works on an archetype with no app_port — the library-archetype gap this closes', async () => {
    const box = sandbox()
    const ctx = makeContext(box)
    await project(ctx, 'mylib', { archetype: 'library' })

    const result = await runPortAdd(ctx, { project: 'mylib', name: 'notebook', containerPort: '8888' })
    assert.equal(result.added.host_port, 8888)
    const compose = box.read('mylib', 'docker-compose.yml') ?? ''
    assert.match(compose, /8888:8888/, 'published even though the archetype itself serves nothing')
  })

  test('a second declared port publishes alongside app_port — the second-frontend/mobile-client gap this closes', async () => {
    const box = sandbox()
    const ctx = makeContext(box)
    await project(ctx, 'myapp', { archetype: 'web' })
    await runUp(ctx, { name: 'myapp', noShell: true }) // assigns app_port 3000
    await runDown(ctx, 'myapp')

    await runPortAdd(ctx, { project: 'myapp', name: 'metro', containerPort: '8081' })
    const compose = box.read('myapp', 'docker-compose.yml') ?? ''
    assert.match(compose, /3000:3000/)
    assert.match(compose, /8081:8081/)
  })

  test('reusing a declared name is EXTRA_PORT_ATTACHED and changes nothing', async () => {
    const box = sandbox()
    const ctx = makeContext(box)
    await project(ctx, 'myapp')
    await runPortAdd(ctx, { project: 'myapp', name: 'notebook', containerPort: '8888' })

    await assert.rejects(
      () => runPortAdd(ctx, { project: 'myapp', name: 'notebook', containerPort: '9999' }),
      (error: unknown) => error instanceof BardolierError && error.code === 'EXTRA_PORT_ATTACHED',
    )
    assert.equal(readManifest(box, 'myapp').extra_ports?.notebook?.host_port, 8888, 'the first declaration is untouched')
  })

  test('an unusable name is INVALID_ARGUMENT', async () => {
    const box = sandbox()
    const ctx = makeContext(box)
    await project(ctx, 'myapp')

    await assert.rejects(
      () => runPortAdd(ctx, { project: 'myapp', name: 'Not A Name', containerPort: '8888' }),
      (error: unknown) => error instanceof BardolierError && error.code === 'INVALID_ARGUMENT',
    )
  })

  test('a missing or out-of-range --container-port is INVALID_ARGUMENT', async () => {
    const box = sandbox()
    const ctx = makeContext(box)
    await project(ctx, 'myapp')

    await assert.rejects(
      () => runPortAdd(ctx, { project: 'myapp', name: 'notebook', containerPort: undefined }),
      (error: unknown) => error instanceof BardolierError && error.code === 'INVALID_ARGUMENT',
    )
    await assert.rejects(
      () => runPortAdd(ctx, { project: 'myapp', name: 'notebook', containerPort: '99999' }),
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
      () => runPortAdd(running, { project: 'myapp', name: 'notebook', containerPort: '8888' }),
      (error: unknown) => error instanceof BardolierError && error.code === 'PROJECT_RUNNING',
    )
    assert.equal(box.read('myapp', 'docker-compose.yml'), before)
  })

  test('an unknown project is PROJECT_NOT_FOUND', async () => {
    const box = sandbox()
    const ctx = makeContext(box)
    await assert.rejects(
      () => runPortAdd(ctx, { project: 'ghost', name: 'notebook', containerPort: '8888' }),
      (error: unknown) => error instanceof BardolierError && error.code === 'PROJECT_NOT_FOUND',
    )
  })
})

// ── port remove (§6) ───────────────────────────────────────────────────────────
describe('port remove (cli-spec.md §6, Ports)', () => {
  test('releases the port and rewrites compose', async () => {
    const box = sandbox()
    const ctx = makeContext(box)
    await project(ctx, 'myapp')
    await runPortAdd(ctx, { project: 'myapp', name: 'notebook', containerPort: '8888' })

    const result = await runPortRemove(ctx, { project: 'myapp', name: 'notebook' })

    const { valid, errors } = validate('port-remove', result)
    assert.ok(valid, `port remove output failed its schema:\n${errors.join('\n')}`)
    assert.deepEqual(result.removed, { name: 'notebook', host_port: 8888 })
    assert.deepEqual(result.extra_ports, [])
    assert.equal(readManifest(box, 'myapp').extra_ports?.notebook, undefined)

    const compose = box.read('myapp', 'docker-compose.yml') ?? ''
    assert.doesNotMatch(compose, /8888/)
  })

  test('the released port is handed to the next add (§5)', async () => {
    const box = sandbox()
    const ctx = makeContext(box)
    await project(ctx, 'alpha')
    await project(ctx, 'beta')
    await runPortAdd(ctx, { project: 'alpha', name: 'notebook', containerPort: '8888' }) // 8888
    await runPortAdd(ctx, { project: 'beta', name: 'notebook', containerPort: '8888' }) // 8889

    await runPortRemove(ctx, { project: 'alpha', name: 'notebook' })

    await project(ctx, 'gamma')
    const gamma = await runPortAdd(ctx, { project: 'gamma', name: 'notebook', containerPort: '8888' })
    assert.equal(gamma.added.host_port, 8888, 'the freed port is reused')
  })

  test('removing what is not declared is EXTRA_PORT_NOT_ATTACHED', async () => {
    const box = sandbox()
    const ctx = makeContext(box)
    await project(ctx, 'myapp')

    await assert.rejects(
      () => runPortRemove(ctx, { project: 'myapp', name: 'notebook' }),
      (error: unknown) => error instanceof BardolierError && error.code === 'EXTRA_PORT_NOT_ATTACHED',
    )
  })

  test('a running project is PROJECT_RUNNING and keeps its port', async () => {
    const box = sandbox()
    const ctx = makeContext(box)
    await project(ctx, 'myapp')
    await runPortAdd(ctx, { project: 'myapp', name: 'notebook', containerPort: '8888' })

    const running = makeContext(box, stubDocker({ running: ['bardolier-myapp'] }))
    await assert.rejects(
      () => runPortRemove(running, { project: 'myapp', name: 'notebook' }),
      (error: unknown) => error instanceof BardolierError && error.code === 'PROJECT_RUNNING',
    )
    assert.equal(readManifest(box, 'myapp').extra_ports?.notebook?.host_port, 8888)
  })

  test('one extra port can be removed while another stays put', async () => {
    const box = sandbox()
    const ctx = makeContext(box)
    await project(ctx, 'myapp')
    await runPortAdd(ctx, { project: 'myapp', name: 'notebook', containerPort: '8888' })
    await runPortAdd(ctx, { project: 'myapp', name: 'metro', containerPort: '8081' })

    const result = await runPortRemove(ctx, { project: 'myapp', name: 'notebook' })
    assert.deepEqual(result.extra_ports.map((p) => p.name), ['metro'])
    const compose = box.read('myapp', 'docker-compose.yml') ?? ''
    assert.match(compose, /8081:8081/)
    assert.doesNotMatch(compose, /8888/)
  })
})

// ── port list (§6) ─────────────────────────────────────────────────────────────
describe('port list (cli-spec.md §6, Ports)', () => {
  test('reports declared ports with their resolved host ports, sorted', async () => {
    const box = sandbox()
    const ctx = makeContext(box)
    await project(ctx, 'myapp')
    await runPortAdd(ctx, { project: 'myapp', name: 'notebook', containerPort: '8888' })
    await runPortAdd(ctx, { project: 'myapp', name: 'metro', containerPort: '8081' })

    const result = collectPortList(ctx, 'myapp')
    const { valid } = validate('port-list', result)
    assert.ok(valid)
    assert.deepEqual(result.extra_ports.map((p) => p.name), ['metro', 'notebook'])
  })

  test('a project with nothing declared lists nothing, no catalogue or daemon needed', async () => {
    const box = sandbox()
    const ctx = makeContext(box, stubDocker({ available: false }))
    await project(ctx, 'myapp')

    assert.deepEqual(collectPortList(ctx, 'myapp'), { project: 'myapp', extra_ports: [] })
  })

  test('an unknown project is PROJECT_NOT_FOUND', () => {
    const box = sandbox()
    const ctx = makeContext(box)
    assert.throws(
      () => collectPortList(ctx, 'ghost'),
      (error: unknown) => error instanceof BardolierError && error.code === 'PROJECT_NOT_FOUND',
    )
  })
})

// ── compose + status + delete integration ───────────────────────────────────────
describe('extra ports elsewhere in the system', () => {
  test('compose publishes app_port before extra ports, extra ports sorted by name', () => {
    const doc = composeDocument({
      manifest: manifest('myapp', {
        app_port: 3000,
        extra_ports: {
          metro: { container_port: 8081, host_port: 8081 },
          notebook: { container_port: 8888, host_port: 8888 },
        },
      }),
      catalogue: null,
    })
    const services = doc.services as Record<string, { ports?: string[] }>
    assert.deepEqual(services.dev?.ports, ['3000:3000', '8081:8081', '8888:8888'])
  })

  test('status reports declared extra ports', async () => {
    const box = sandbox()
    const ctx = makeContext(box)
    await project(ctx, 'myapp')
    await runPortAdd(ctx, { project: 'myapp', name: 'notebook', containerPort: '8888' })

    const status = await collectStatus(ctx, 'myapp')
    assert.deepEqual(status.projects[0]?.extra_ports, [
      { name: 'notebook', host_port: 8888, container_port: 8888, url: 'http://localhost:8888' },
    ])
  })

  test('deleting a project with extra ports releases them', async () => {
    const box = sandbox()
    const ctx = makeContext(box)
    await project(ctx, 'myapp')
    await runPortAdd(ctx, { project: 'myapp', name: 'notebook', containerPort: '8888' })

    const result = await runDelete(ctx, { name: 'myapp', force: true, purge: false, json: false })
    assert.ok(result.released_ports.includes(8888))
  })

  test('up refuses a squatted extra port and does not silently remap it', async () => {
    const box = sandbox()
    const ctx = makeContext(box)
    await project(ctx, 'myapp')
    await runPortAdd(ctx, { project: 'myapp', name: 'notebook', containerPort: '8888' })

    const squatted = makeContext(box, stubDocker(), { ports: stubPorts([8888]) })
    await assert.rejects(
      () => runUp(squatted, { name: 'myapp', noShell: true }),
      (error: unknown) => error instanceof BardolierError && error.code === 'PORT_UNAVAILABLE',
    )
  })
})

describe('a partial view refuses rather than under-reporting (§5, §6)', () => {
  test('assignedPorts throws ROOT_UNREADABLE when any configured root is unreadable', () => {
    const box = sandbox()
    const rootB = secondRoot()
    const ctx = twoRoots(box, rootB)
    box.writeProject('alpha', manifest('alpha', { services: { postgres: { host_port: 5433 } } }))
    rmSync(rootB, { recursive: true, force: true })

    assert.throws(
      () => assignedPorts(ctx.config),
      (error: unknown) => error instanceof BardolierError && error.code === 'ROOT_UNREADABLE',
    )
  })

  test('a port allocated in one root is never handed out in another', async () => {
    const box = sandbox()
    const rootB = secondRoot()
    const ctx = twoRoots(box, rootB)

    const a = await runNew(ctx, { name: 'alpha', archetype: 'web', services: 'postgres', root: 'a' })
    const b = await runNew(ctx, { name: 'beta', archetype: 'web', services: 'postgres', root: 'b' })
    assert.notEqual(a.services[0]?.host_port, b.services[0]?.host_port)
  })

  test('volumes: SSD_NOT_MOUNTED when every root is gone, ROOT_UNREADABLE when only some are', async () => {
    const box = sandbox()
    const rootB = secondRoot()
    const ctx = twoRoots(box, rootB)
    box.writeProject('alpha', manifest('alpha'))

    rmSync(box.root, { recursive: true, force: true })
    rmSync(rootB, { recursive: true, force: true })
    await assert.rejects(
      () => scanVolumes(ctx),
      (error: unknown) => error instanceof BardolierError && error.code === 'SSD_NOT_MOUNTED',
    )
  })
})
