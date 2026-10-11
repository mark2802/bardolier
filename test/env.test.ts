/**
 * `bardolier env`: docs/env.md re-rendered from the manifest (cli-spec.md §6, §10).
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { renameSync, rmSync, writeFileSync } from 'node:fs'

import { validate } from '../cli/src/schema.ts'
import { runNew } from '../cli/src/commands/new.ts'
import { runServiceAdd } from '../cli/src/commands/service.ts'
import { runEnv } from '../cli/src/commands/env.ts'
import { requireProject, writeManifest } from '../cli/src/workspace.ts'
import { makeContext, sandboxes } from './helpers.ts'

const sandbox = sandboxes()

describe('env (cli-spec.md §6)', () => {
  test('prints without writing; --write refreshes after a service is added, then reports unchanged', async () => {
    const box = sandbox()
    const ctx = makeContext(box)
    await runNew(ctx, { name: 'myapp', archetype: 'web', services: undefined })
    const seeded = box.read('myapp', 'work', 'myapp', 'docs', 'env.md') ?? ''
    assert.ok(!seeded.includes('redis:6379'))

    await runServiceAdd(ctx, { project: 'myapp', service: 'redis' })

    const preview = runEnv(ctx, 'myapp')
    assert.ok(validate('env', preview).valid)
    assert.equal(preview.written, false)
    assert.equal(preview.changed, true)
    assert.ok(preview.content.includes('`redis:6379`'))
    assert.equal(box.read('myapp', 'work', 'myapp', 'docs', 'env.md'), seeded, 'a preview must not write')

    assert.equal(runEnv(ctx, 'myapp', { write: true }).changed, true)
    assert.ok((box.read('myapp', 'work', 'myapp', 'docs', 'env.md') ?? '').includes('`redis:6379`'))
    assert.equal(runEnv(ctx, 'myapp', { write: true }).changed, false)
  })

  test('--write recreates a missing docs/ directory', async () => {
    const box = sandbox()
    const ctx = makeContext(box)
    await runNew(ctx, { name: 'myapp', archetype: 'web', services: undefined })
    rmSync(box.path('myapp', 'work', 'myapp', 'docs'), { recursive: true })
    runEnv(ctx, 'myapp', { write: true })
    assert.ok(box.exists('myapp', 'work', 'myapp', 'docs', 'env.md'))
  })

  test('--write refuses an env.md bardolier did not write', async () => {
    const box = sandbox()
    const ctx = makeContext(box)
    await runNew(ctx, { name: 'myapp', archetype: 'web', services: undefined })
    writeFileSync(box.path('myapp', 'work', 'myapp', 'docs', 'env.md'), 'DATABASE_URL=...')
    assert.throws(() => runEnv(ctx, 'myapp', { write: true }), { code: 'INVALID_ARGUMENT' })
    assert.equal(box.read('myapp', 'work', 'myapp', 'docs', 'env.md'), 'DATABASE_URL=...')
  })

  test('--write without a work_folder refuses and creates nothing; printing still works', async () => {
    const box = sandbox()
    const ctx = makeContext(box)
    await runNew(ctx, { name: 'myapp', archetype: 'web', services: undefined })
    const { manifest, dir } = requireProject(ctx, 'myapp')
    delete manifest.work_folder
    writeManifest(ctx, dir, manifest)
    rmSync(box.path('myapp', 'work', 'myapp'), { recursive: true })

    assert.throws(() => runEnv(ctx, 'myapp', { write: true }), { code: 'INVALID_ARGUMENT' })
    assert.equal(box.exists('myapp', 'work', 'myapp'), false)
    const preview = runEnv(ctx, 'myapp')
    assert.ok(preview.content.startsWith('# Environment — myapp'))
    assert.ok(!preview.content.includes('/work/myapp'), 'no folder is recorded, so none is named')
    assert.equal(preview.changed, false)
  })

  test('--write updates the recorded work_folder a clone kept, not a new work/<name>/', async () => {
    const box = sandbox()
    const ctx = makeContext(box)
    await runNew(ctx, { name: 'myapp', archetype: 'web', services: undefined })
    renameSync(box.path('myapp', 'work', 'myapp'), box.path('myapp', 'work', 'origin'))
    const { manifest, dir } = requireProject(ctx, 'myapp')
    writeManifest(ctx, dir, { ...manifest, work_folder: 'origin' })

    const out = runEnv(ctx, 'myapp', { write: true })
    assert.ok(out.path.endsWith('work/origin/docs/env.md'), out.path)
    assert.ok((box.read('myapp', 'work', 'origin', 'docs', 'env.md') ?? '').includes('/work/origin'))
    assert.equal(box.exists('myapp', 'work', 'myapp'), false)
  })
})
