/**
 * `bardolier adopt` — the mechanical half of `docs/migration-guide.md` steps
 * 3-4 (cli-spec.md §6, phase 30).
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { BardolierError } from '../cli/src/errors.ts'
import { validate } from '../cli/src/schema.ts'
import { runAdopt } from '../cli/src/commands/adopt.ts'
import { stagingPath } from '../cli/src/transfer.ts'
import { discoverProjects } from '../cli/src/projects.ts'
import { writeManifest } from '../cli/src/workspace.ts'
import { FIXED_NOW, makeContext, manifest, readManifest, sandboxes, tempDirs, twoRoots } from './helpers.ts'

const sandbox = sandboxes()
const externalDir = tempDirs('bardolier-adopt-source-')

/** A directory outside any configured root — an "existing project" to adopt. */
function fixtureSource(dir: string): string {
  const repo = join(dir, 'my-old-app')
  mkdirSync(join(repo, 'src'), { recursive: true })
  writeFileSync(join(repo, 'package.json'), '{"name":"my-old-app"}')
  writeFileSync(join(repo, 'src', 'index.js'), 'console.log("hi")')
  return repo
}

describe('adopt (cli-spec.md §6, phase 30)', () => {
  test('creates the project and copies the source into work/<basename>, leaving the source untouched', async () => {
    const box = sandbox()
    const source = fixtureSource(externalDir())

    const result = await runAdopt(makeContext(box), {
      source,
      name: 'myapp',
      archetype: 'web',
      services: undefined,
      move: false,
      dryRun: false,
    })

    assert.ok(validate('adopt', result).valid, 'adopt output must match adopt.schema.json')
    assert.equal(result.dry_run, false)
    assert.equal(result.mode, 'copy')
    assert.equal(result.project.dir, box.path('myapp'))
    assert.equal(result.source.basename, 'my-old-app')
    assert.ok(result.bytes > 0)

    assert.equal(box.read('myapp', 'work', 'my-old-app', 'package.json'), '{"name":"my-old-app"}')
    assert.equal(box.read('myapp', 'work', 'my-old-app', 'src', 'index.js'), 'console.log("hi")')
    assert.equal(box.exists('myapp', 'work', 'CLAUDE.md'), true, 'the archetype seed still landed')

    // The source is untouched — this was a copy, not a move.
    assert.equal(existsSync(source), true)
    assert.equal(readFileSync(join(source, 'package.json'), 'utf8'), '{"name":"my-old-app"}')

    const manifest = readManifest(box, 'myapp')
    assert.equal(manifest.archetype, 'web')
    assert.equal(manifest.created, FIXED_NOW.toISOString())
    assert.equal(typeof manifest.app_port, 'number')
  })

  test('--services attaches and allocates ports, reported in `services`', async () => {
    const box = sandbox()
    const source = fixtureSource(externalDir())

    const result = await runAdopt(makeContext(box), {
      source,
      name: 'myapp',
      archetype: 'web',
      services: 'postgres',
      move: false,
      dryRun: false,
    })

    assert.deepEqual(result.requested_services, ['postgres'])
    assert.equal(result.services.length, 1)
    assert.equal(result.services[0]?.key, 'postgres')
    assert.equal(typeof result.services[0]?.host_port, 'number')
  })

  test('--move deletes the source once the copy has landed', async () => {
    const box = sandbox()
    const source = fixtureSource(externalDir())

    const result = await runAdopt(makeContext(box), {
      source,
      name: 'myapp',
      archetype: 'web',
      services: undefined,
      move: true,
      dryRun: false,
    })

    assert.equal(result.mode, 'move')
    assert.equal(box.read('myapp', 'work', 'my-old-app', 'package.json'), '{"name":"my-old-app"}')
    assert.equal(existsSync(source), false, 'the source should be gone after --move')
  })

  test('--dry-run writes nothing, reports no ports, but reports real bytes', async () => {
    const box = sandbox()
    const source = fixtureSource(externalDir())

    const result = await runAdopt(makeContext(box), {
      source,
      name: 'myapp',
      archetype: 'web',
      services: 'postgres',
      move: false,
      dryRun: true,
    })

    assert.ok(validate('adopt', result).valid, 'a --dry-run payload must still match the schema')
    assert.equal(result.dry_run, true)
    assert.equal(result.manifest_path, undefined)
    assert.equal(result.compose_path, undefined)
    assert.equal(result.seeded, undefined)
    assert.deepEqual(result.requested_services, ['postgres'])
    assert.deepEqual(result.services, [], 'a dry run never allocates, let alone reports, a port')
    assert.ok(result.bytes > 0, 'sizing the source is a read-only stat walk, so this is real even in --dry-run')

    assert.equal(box.exists('myapp'), false, 'nothing should be written')
    assert.equal(existsSync(source), true, 'the source is untouched')
    assert.deepEqual(discoverProjects(makeContext(box).config).projects, [])
  })

  test('a name already taken (in any root) is PROJECT_EXISTS, and leaves nothing behind', async () => {
    const box = sandbox()
    const other = externalDir()
    const source = fixtureSource(externalDir())
    const ctx = twoRoots(box, other)
    mkdirSync(join(other, 'myapp'), { recursive: true })
    writeManifest(ctx, join(other, 'myapp'), manifest('myapp'))

    await assert.rejects(
      () => runAdopt(ctx, { source, name: 'myapp', archetype: 'web', services: undefined, move: false, dryRun: false }),
      (error: unknown) => error instanceof BardolierError && error.code === 'PROJECT_EXISTS',
    )
    assert.equal(box.exists('myapp'), false)
    assert.equal(existsSync(stagingPath(box.root, 'myapp')), false)
  })

  test('a source that is not a directory is INVALID_ARGUMENT', async () => {
    const box = sandbox()
    const notADir = join(externalDir(), 'not-a-dir.txt')
    writeFileSync(notADir, 'x')

    await assert.rejects(
      () => runAdopt(makeContext(box), { source: notADir, name: 'myapp', archetype: 'web', services: undefined, move: false, dryRun: false }),
      (error: unknown) => error instanceof BardolierError && error.code === 'INVALID_ARGUMENT',
    )
    await assert.rejects(
      () =>
        runAdopt(makeContext(box), {
          source: join(externalDir(), 'ghost'),
          name: 'myapp',
          archetype: 'web',
          services: undefined,
          move: false,
          dryRun: false,
        }),
      (error: unknown) => error instanceof BardolierError && error.code === 'INVALID_ARGUMENT',
    )
  })

  test('an unusable name or unknown archetype is INVALID_ARGUMENT before the source is even read', async () => {
    const box = sandbox()
    const source = fixtureSource(externalDir())

    await assert.rejects(
      () => runAdopt(makeContext(box), { source, name: 'My App', archetype: 'web', services: undefined, move: false, dryRun: false }),
      (error: unknown) => error instanceof BardolierError && error.code === 'INVALID_ARGUMENT',
    )
    await assert.rejects(
      () => runAdopt(makeContext(box), { source, name: 'myapp', archetype: 'spaceship', services: undefined, move: false, dryRun: false }),
      (error: unknown) => error instanceof BardolierError && error.code === 'INVALID_ARGUMENT',
    )
  })

  test('--root places it on another configured root', async () => {
    const box = sandbox()
    const other = externalDir()
    const source = fixtureSource(externalDir())

    const result = await runAdopt(twoRoots(box, other), {
      source,
      name: 'myapp',
      archetype: 'library',
      services: undefined,
      root: 'b',
      move: false,
      dryRun: false,
    })
    assert.equal(result.project.root, 'b')
    assert.equal(result.project.dir, join(other, 'myapp'))
  })
})
