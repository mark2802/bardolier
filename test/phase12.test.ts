/**
 * Phase 12 — extra ports (`docs/migration-guide-gaps.md`, resolved): a named,
 * per-project, archetype-independent port published from the dev container —
 * a second frontend/backend a mobile client or another browser tab must reach
 * directly, or an interactive dev tool on an archetype that otherwise
 * publishes nothing. Same §5 rules as a service's port (unique, stable,
 * banded from the caller's own `--container-port`, released on remove).
 */

import { test, describe, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { parse as parseYaml } from 'yaml'

import { CprojError } from '../cli/src/errors.ts'
import { validate } from '../cli/src/schema.ts'
import { composeDocument } from '../cli/src/compose.ts'
import { runNew } from '../cli/src/commands/new.ts'
import { runUp } from '../cli/src/commands/up.ts'
import { runDown } from '../cli/src/commands/down.ts'
import { runDelete } from '../cli/src/commands/delete.ts'
import { collectStatus } from '../cli/src/commands/status.ts'
import { collectPortList, runPortAdd, runPortRemove } from '../cli/src/commands/port.ts'
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

function readManifest(box: Sandbox, project: string): ProjectManifest {
  const text = box.read(project, 'project.yml')
  assert.ok(text, `${project}/project.yml is missing`)
  return parseYaml(text) as ProjectManifest
}

async function project(ctx: Context, name: string, archetype: 'web' | 'library' = 'web'): Promise<void> {
  await runNew(ctx, { name, archetype, services: undefined })
}

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
    await project(ctx, 'mylib', 'library')

    const result = await runPortAdd(ctx, { project: 'mylib', name: 'notebook', containerPort: '8888' })
    assert.equal(result.added.host_port, 8888)
    const compose = box.read('mylib', 'docker-compose.yml') ?? ''
    assert.match(compose, /8888:8888/, 'published even though the archetype itself serves nothing')
  })

  test('a second declared port publishes alongside app_port — the second-frontend/mobile-client gap this closes', async () => {
    const box = sandbox()
    const ctx = makeContext(box)
    await project(ctx, 'myapp', 'web')
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
      (error: unknown) => error instanceof CprojError && error.code === 'EXTRA_PORT_ATTACHED',
    )
    assert.equal(readManifest(box, 'myapp').extra_ports?.notebook?.host_port, 8888, 'the first declaration is untouched')
  })

  test('an unusable name is INVALID_ARGUMENT', async () => {
    const box = sandbox()
    const ctx = makeContext(box)
    await project(ctx, 'myapp')

    await assert.rejects(
      () => runPortAdd(ctx, { project: 'myapp', name: 'Not A Name', containerPort: '8888' }),
      (error: unknown) => error instanceof CprojError && error.code === 'INVALID_ARGUMENT',
    )
  })

  test('a missing or out-of-range --container-port is INVALID_ARGUMENT', async () => {
    const box = sandbox()
    const ctx = makeContext(box)
    await project(ctx, 'myapp')

    await assert.rejects(
      () => runPortAdd(ctx, { project: 'myapp', name: 'notebook', containerPort: undefined }),
      (error: unknown) => error instanceof CprojError && error.code === 'INVALID_ARGUMENT',
    )
    await assert.rejects(
      () => runPortAdd(ctx, { project: 'myapp', name: 'notebook', containerPort: '99999' }),
      (error: unknown) => error instanceof CprojError && error.code === 'INVALID_ARGUMENT',
    )
  })

  test('a running project is PROJECT_RUNNING and is left exactly as it was', async () => {
    const box = sandbox()
    const ctx = makeContext(box)
    await project(ctx, 'myapp')
    const before = box.read('myapp', 'docker-compose.yml')

    const running = makeContext(box, stubDocker({ running: ['cproj-myapp'] }))
    await assert.rejects(
      () => runPortAdd(running, { project: 'myapp', name: 'notebook', containerPort: '8888' }),
      (error: unknown) => error instanceof CprojError && error.code === 'PROJECT_RUNNING',
    )
    assert.equal(box.read('myapp', 'docker-compose.yml'), before)
  })

  test('an unknown project is PROJECT_NOT_FOUND', async () => {
    const box = sandbox()
    const ctx = makeContext(box)
    await assert.rejects(
      () => runPortAdd(ctx, { project: 'ghost', name: 'notebook', containerPort: '8888' }),
      (error: unknown) => error instanceof CprojError && error.code === 'PROJECT_NOT_FOUND',
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
      (error: unknown) => error instanceof CprojError && error.code === 'EXTRA_PORT_NOT_ATTACHED',
    )
  })

  test('a running project is PROJECT_RUNNING and keeps its port', async () => {
    const box = sandbox()
    const ctx = makeContext(box)
    await project(ctx, 'myapp')
    await runPortAdd(ctx, { project: 'myapp', name: 'notebook', containerPort: '8888' })

    const running = makeContext(box, stubDocker({ running: ['cproj-myapp'] }))
    await assert.rejects(
      () => runPortRemove(running, { project: 'myapp', name: 'notebook' }),
      (error: unknown) => error instanceof CprojError && error.code === 'PROJECT_RUNNING',
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
      (error: unknown) => error instanceof CprojError && error.code === 'PROJECT_NOT_FOUND',
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

    const result = await runDelete(ctx, { name: 'myapp', force: true, keepData: true, purge: false, json: false })
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
      (error: unknown) => error instanceof CprojError && error.code === 'PORT_UNAVAILABLE',
    )
  })
})
