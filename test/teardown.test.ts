/**
 * `bardolier teardown` — reversing an Install without touching project data
 * (cli-spec.md §6, Lifecycle / SSD).
 *
 * `binDirs` is always passed explicitly here, never left to its real default
 * — see `commands/teardown.ts`'s header for why a test must not be able to
 * reach the machine's actual `/opt/homebrew/bin` and unlink a real install.
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { BardolierError } from '../cli/src/errors.ts'
import { validate } from '../cli/src/schema.ts'
import { shimPath } from '../cli/src/install.ts'
import { runTeardown } from '../cli/src/commands/teardown.ts'
import { makeContext, project, sandboxes, stubConfirm, stubDocker, tempDirs } from './helpers.ts'

const sandbox = sandboxes()
const tempDir = tempDirs('bardolier-teardown-')

function request(overrides: Partial<{ images: boolean; force: boolean; json: boolean }> = {}) {
  return { images: false, force: true, json: false, ...overrides }
}

describe('teardown (cli-spec.md §6)', () => {
  test('the payload matches teardown.schema.json', async () => {
    const box = sandbox()
    const ctx = makeContext(box, stubDocker())
    const output = await runTeardown(ctx, request(), [])
    assert.ok(validate('teardown', output).valid)
  })

  test('confirms unless --force, and a refusal touches nothing', async () => {
    const box = sandbox()
    await project(makeContext(box, stubDocker()), 'alpha')
    const confirm = stubConfirm(false)
    const docker = stubDocker({ running: ['bardolier-alpha'] })

    const output = await runTeardown(makeContext(box, docker, { confirm }), request({ force: false }), [])

    assert.equal(output.confirmed, false)
    assert.equal(confirm.questions.length, 1)
    assert.deepEqual(docker.calls, [])
    assert.ok(existsSync(join(box.home, '.config', 'bardolier')), 'a declined teardown must leave config alone')
  })

  test('under --json with no --force, refuses rather than guessing', async () => {
    const box = sandbox()
    const ctx = makeContext(box, stubDocker())
    await assert.rejects(
      () => runTeardown(ctx, request({ force: false, json: true }), []),
      (error: unknown) => error instanceof BardolierError && error.code === 'INVALID_ARGUMENT',
    )
    assert.ok(existsSync(join(box.home, '.config', 'bardolier')), 'the refusal must leave config alone')
  })

  test('stops every running project, like down-all', async () => {
    const box = sandbox()
    const ctx0 = makeContext(box, stubDocker())
    await project(ctx0, 'alpha')
    const docker = stubDocker({ running: ['bardolier-alpha'] })

    const output = await runTeardown(makeContext(box, docker), request(), [])

    assert.deepEqual(output.stopped, ['alpha'])
    assert.equal(docker.calls.some((call) => call.kind === 'down'), true)
  })

  test('removes the config directory — config.yml and the root index both live there', async () => {
    const box = sandbox()
    const ctx = makeContext(box, stubDocker())
    const configDir = join(box.home, '.config', 'bardolier')
    assert.ok(existsSync(configDir), 'sanity: the sandbox seeds this directory')

    const output = await runTeardown(ctx, request(), [])

    assert.equal(output.config_removed, true)
    assert.equal(output.config_dir, configDir)
    assert.equal(existsSync(configDir), false)
  })

  test('removes a bardolier/bdlr link this checkout made, and leaves an unrelated one alone', async () => {
    const box = sandbox()
    const ours = tempDir()
    const foreign = tempDir()
    symlinkSync(shimPath(), join(ours, 'bardolier'))
    writeFileSync(join(foreign, 'bardolier'), '#!/bin/sh\necho not us\n')

    const ctx = makeContext(box, stubDocker())
    const output = await runTeardown(ctx, request(), [ours, foreign])

    assert.equal(existsSync(join(ours, 'bardolier')), false)
    assert.equal(existsSync(join(foreign, 'bardolier')), true, 'a real file that is not our link must survive')
    assert.deepEqual(
      output.unlinked.map((l) => l.path),
      [join(ours, 'bardolier')],
    )
  })

  test('--images removes only the base images present, and none without the flag', async () => {
    const box = sandbox()
    const docker = stubDocker({ images: ['bardolier-web', 'bardolier-and'] })

    const withoutFlag = await runTeardown(makeContext(box, docker), request(), [])
    assert.deepEqual(withoutFlag.images_removed, [])
    assert.deepEqual(docker.calls.filter((c) => c.kind === 'removeImage'), [])

    const withFlag = await runTeardown(makeContext(box, docker), request({ images: true }), [])
    assert.deepEqual([...withFlag.images_removed].sort(), ['bardolier-and', 'bardolier-web'])
    assert.equal(await docker.images().then((i) => i.length), 0, 'the stub actually forgot them')
  })

  test('never touches a project directory or its data', async () => {
    const box = sandbox()
    const ctx = makeContext(box, stubDocker())
    await project(ctx, 'alpha')

    await runTeardown(ctx, request(), [])

    assert.ok(box.exists('alpha', 'project.yml'), 'teardown must never delete a project')
  })

  test('a daemon-less teardown still removes links and config', async () => {
    const box = sandbox()
    const ours = tempDir()
    mkdirSync(ours, { recursive: true })
    symlinkSync(shimPath(), join(ours, 'bardolier'))
    const docker = stubDocker({ available: false })

    const output = await runTeardown(makeContext(box, docker), request(), [ours])

    assert.equal(output.docker_available, false)
    assert.equal(output.config_removed, true)
    assert.equal(output.unlinked.length, 1)
  })
})
