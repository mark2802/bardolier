/**
 * `bardolier shell`: the argv the CLI resolves and the app runs.
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { cpSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { BardolierError } from '../cli/src/errors.ts'
import { validate } from '../cli/src/schema.ts'
import { runNew } from '../cli/src/commands/new.ts'
import { runShell } from '../cli/src/commands/shell.ts'
import { requireProject, writeManifest } from '../cli/src/workspace.ts'
import type { Context } from '../cli/src/context.ts'
import { makeContext, project, sandboxes, stubDocker } from './helpers.ts'

const sandbox = sandboxes()

/** Record (or clear) `work_folder` the way a hand edit of project.yml would. */
function setWorkFolder(ctx: Context, name: string, folder: string | undefined): void {
  const { manifest, dir } = requireProject(ctx, name)
  if (folder === undefined) delete manifest.work_folder
  else manifest.work_folder = folder
  writeManifest(ctx, dir, manifest)
}

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
      exec: ['docker', 'exec', '-w', '/work/alpha', '-it', 'bardolier-alpha', 'sh', '-c', 'command -v zsh >/dev/null && exec zsh || exec bash'],
      workdir: '/work/alpha',
    })
    assert.ok(validate('shell', output).valid)
  })

  test('a project with no work_folder opens in /work', async () => {
    const box = sandbox()
    const ctx = makeContext(box, stubDocker({ running: ['bardolier-alpha'] }))
    await project(ctx, 'alpha')
    setWorkFolder(ctx, 'alpha', undefined)

    const output = await runShell(ctx, 'alpha')
    assert.deepEqual(output.exec, ['docker', 'exec', '-it', 'bardolier-alpha', 'sh', '-c', 'command -v zsh >/dev/null && exec zsh || exec bash'])
    assert.equal(output.workdir, '/work')
    assert.ok(validate('shell', output).valid)
  })

  test('a work_folder whose directory is gone falls back to /work', async () => {
    const box = sandbox()
    const ctx = makeContext(box, stubDocker({ running: ['bardolier-alpha'] }))
    await project(ctx, 'alpha')
    rmSync(box.path('alpha', 'work', 'alpha'), { recursive: true })

    assert.equal((await runShell(ctx, 'alpha')).workdir, '/work')
  })

  test('the recorded work_folder is the workdir, whatever else sits in work/', async () => {
    const box = sandbox()
    const ctx = makeContext(box, stubDocker({ running: ['bardolier-alpha'] }))
    await project(ctx, 'alpha')
    renameSync(box.path('alpha', 'work', 'alpha'), box.path('alpha', 'work', 'origin'))
    cpSync(box.path('alpha', 'work', 'origin'), box.path('alpha', 'work', 'other'), { recursive: true })
    writeFileSync(box.path('alpha', 'work', 'CLAUDE.md'), '# not a signal any more')
    setWorkFolder(ctx, 'alpha', 'origin')

    assert.equal((await runShell(ctx, 'alpha')).workdir, '/work/origin')
  })

  test('--root swaps to `docker exec -u root`, same container, same checks (phase 14)', async () => {
    const box = sandbox()
    const docker = stubDocker({ running: ['bardolier-alpha'] })
    const ctx = makeContext(box, docker)
    await project(ctx, 'alpha')

    const output = await runShell(ctx, 'alpha', { root: true })
    assert.deepEqual(output.exec, ['docker', 'exec', '-u', 'root', '-w', '/work/alpha', '-it', 'bardolier-alpha', 'sh', '-c', 'command -v zsh >/dev/null && exec zsh || exec bash'])
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
