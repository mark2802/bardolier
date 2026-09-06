/**
 * `bardolier shell`: the argv the CLI resolves and the app runs.
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { join } from 'node:path'

import { BardolierError } from '../cli/src/errors.ts'
import { validate } from '../cli/src/schema.ts'
import { runNew } from '../cli/src/commands/new.ts'
import { runShell } from '../cli/src/commands/shell.ts'
import { makeContext, project, sandboxes, stubDocker } from './helpers.ts'

const sandbox = sandboxes()

// ── shell (§6, Shell) ─────────────────────────────────────────────────────────
describe('shell (cli-spec.md §6, Shell)', () => {
  test('resolves the dev container and returns the exec argv', async () => {
    const box = sandbox()
    const docker = stubDocker({ running: ['bardolier-alpha'] })
    const ctx = makeContext(box, docker)
    await project(ctx, 'alpha')

    const output = await runShell(ctx, 'alpha')
    assert.deepEqual(output, {
      project: 'alpha',
      container: 'bardolier-alpha',
      exec: ['docker', 'exec', '-it', 'bardolier-alpha', 'bash'],
      workdir: '/work',
    })
    assert.ok(validate('shell', output).valid)
  })

  test('--root swaps to `docker exec -u root`, same container, same checks (phase 14)', async () => {
    const box = sandbox()
    const docker = stubDocker({ running: ['bardolier-alpha'] })
    const ctx = makeContext(box, docker)
    await project(ctx, 'alpha')

    const output = await runShell(ctx, 'alpha', { root: true })
    assert.deepEqual(output.exec, ['docker', 'exec', '-u', 'root', '-it', 'bardolier-alpha', 'bash'])
    assert.ok(validate('shell', output).valid)
  })

  test('a stopped project is PROJECT_STOPPED with --root too', async () => {
    const box = sandbox()
    const docker = stubDocker({ running: [] })
    const ctx = makeContext(box, docker)
    await project(ctx, 'alpha')

    await assert.rejects(
      () => runShell(ctx, 'alpha', { root: true }),
      (error: unknown) => error instanceof BardolierError && error.code === 'PROJECT_STOPPED',
    )
  })

  test('spawns nothing — the daemon is only ever asked what is running', async () => {
    const box = sandbox()
    const docker = stubDocker({ running: ['bardolier-alpha'] })
    const ctx = makeContext(box, docker)
    await project(ctx, 'alpha')

    await runShell(ctx, 'alpha')
    assert.deepEqual(docker.calls, [], 'shell mutated Docker; it must only resolve a name')
  })

  test('a stopped project is PROJECT_STOPPED, not a silent start', async () => {
    const box = sandbox()
    const docker = stubDocker({ running: [] })
    const ctx = makeContext(box, docker)
    await project(ctx, 'alpha')

    await assert.rejects(
      () => runShell(ctx, 'alpha'),
      (error: unknown) => error instanceof BardolierError && error.code === 'PROJECT_STOPPED',
    )
    assert.deepEqual(docker.calls, [], 'a refused shell started something')
  })

  test('a project whose services are up but whose dev container is not is still PROJECT_STOPPED', async () => {
    const box = sandbox()
    const ctx = makeContext(box, stubDocker({ running: ['bardolier-alpha-postgres'] }))
    await project(ctx, 'alpha', { services: 'postgres' })

    await assert.rejects(
      () => runShell(ctx, 'alpha'),
      (error: unknown) => error instanceof BardolierError && error.code === 'PROJECT_STOPPED',
    )
  })

  test('an unreachable daemon is DOCKER_UNAVAILABLE, not a false "stopped"', async () => {
    const box = sandbox()
    const ctx = makeContext(box, stubDocker({ available: true }))
    await project(ctx, 'alpha')
    const offline = makeContext(box, stubDocker({ available: false }))

    await assert.rejects(
      () => runShell(offline, 'alpha'),
      (error: unknown) => error instanceof BardolierError && error.code === 'DOCKER_UNAVAILABLE',
    )
  })

  test('an unknown project is PROJECT_NOT_FOUND', async () => {
    const ctx = makeContext(sandbox(), stubDocker({ running: [] }))
    await assert.rejects(
      () => runShell(ctx, 'ghost'),
      (error: unknown) => error instanceof BardolierError && error.code === 'PROJECT_NOT_FOUND',
    )
  })
})

describe('shell-open (app-spec.md §7)', () => {
  test('the CLI resolves argv and spawns nothing; the app runs it', async () => {
    const box = sandbox()
    const ctx = makeContext(box, stubDocker({ running: ['bardolier-alpha'] }))
    await runNew(ctx, { name: 'alpha', archetype: 'web', services: undefined })

    const invocation = await runShell(ctx, 'alpha')

    assert.ok(validate('shell', invocation).valid, validate('shell', invocation).errors.join('\n'))
    assert.equal(invocation.exec[0], 'docker')
    assert.ok(invocation.exec.length > 1, 'argv, so the app needs no quoting rules of its own')
  })
})
