/**
 * `bardolier install` — linking `bardolier`/`bdlr` onto a bin directory a
 * Finder-launched app can also find (cli-spec.md §6, phase 28).
 *
 * Every test passes its own directories, never the real conventional ones —
 * `install.ts`'s header explains why the mutating half of this module takes
 * a directory explicitly instead of going through Context.
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, readlinkSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { BardolierError } from '../cli/src/errors.ts'
import { validate } from '../cli/src/schema.ts'
import { chooseBinDir, findInstalled, linkOne, runInstall, satisfiesNodeEngine, shimPath } from '../cli/src/install.ts'
import { tempDirs } from './helpers.ts'

const dir = tempDirs('bardolier-install-')

describe('runInstall (cli-spec.md §6, phase 28)', () => {
  test('links bardolier and bdlr at --bin-dir, pointing at the real shim', () => {
    const binDir = dir()
    const result = runInstall({ binDir, force: false })

    assert.ok(validate('install', result).valid, 'install output must match install.schema.json')
    assert.equal(result.bin_dir, binDir)
    assert.equal(result.created_bin_dir, false)
    assert.equal(result.resolves, true)
    assert.equal(result.links.length, 2)
    for (const link of result.links) {
      assert.equal(link.action, 'created')
      assert.equal(realpathSync(link.path), shimPath())
    }
    assert.equal(readlinkSync(join(binDir, 'bardolier')), shimPath())
  })

  test('is idempotent: a second run reports already_linked, not replaced', () => {
    const binDir = dir()
    runInstall({ binDir, force: false })
    const second = runInstall({ binDir, force: false })
    for (const link of second.links) assert.equal(link.action, 'already_linked')
  })

  test('a dangling link from a previous install is replaced without --force', () => {
    const binDir = dir()
    symlinkSync(join(binDir, 'nowhere'), join(binDir, 'bardolier'))
    assert.equal(existsSync(join(binDir, 'bardolier')), false, 'sanity: the fixture link is dangling')

    const result = runInstall({ binDir, force: false })
    const bardolier = result.links.find((l) => l.name === 'bardolier')
    assert.equal(bardolier?.action, 'replaced')
    assert.equal(realpathSync(join(binDir, 'bardolier')), shimPath())
  })

  test('an occupied path that is not our link refuses without --force, and replaces with it', () => {
    const binDir = dir()
    writeFileSync(join(binDir, 'bardolier'), '#!/bin/sh\necho not us\n')

    assert.throws(
      () => runInstall({ binDir, force: false }),
      (error: unknown) => error instanceof BardolierError && error.code === 'INSTALL_PATH_OCCUPIED',
    )
    assert.equal(existsSync(join(binDir, 'bardolier')), true, 'the refusal left the occupying file alone')

    const forced = runInstall({ binDir, force: true })
    const bardolier = forced.links.find((l) => l.name === 'bardolier')
    assert.equal(bardolier?.action, 'replaced')
  })

  test('a directory in the way is refused even with --force', () => {
    const binDir = dir()
    mkdirSync(join(binDir, 'bardolier'))

    assert.throws(
      () => runInstall({ binDir, force: true }),
      (error: unknown) => error instanceof BardolierError && error.code === 'INSTALL_PATH_OCCUPIED',
    )
  })

  test('an explicit --bin-dir that does not exist is INSTALL_NO_WRITABLE_DIR', () => {
    assert.throws(
      () => runInstall({ binDir: join(dir(), 'nonexistent'), force: false }),
      (error: unknown) => error instanceof BardolierError && error.code === 'INSTALL_NO_WRITABLE_DIR',
    )
  })
})

describe('chooseBinDir', () => {
  test('picks the first writable directory in the list', () => {
    const unwritable = dir()
    const writable = dir()
    const result = chooseBinDir({}, [join(unwritable, 'ghost'), writable])
    assert.equal(result.dir, writable)
    assert.equal(result.created, false)
  })

  test('falls back to creating the fallback dir when nothing in the list is usable', () => {
    const fallback = join(dir(), 'nested', '.local', 'bin')
    const result = chooseBinDir({}, [join(dir(), 'ghost-a'), join(dir(), 'ghost-b')], fallback)
    assert.equal(result.dir, fallback)
    assert.equal(result.created, true)
    assert.equal(existsSync(fallback), true)
  })
})

describe('findInstalled', () => {
  test('finds an executable literally named bardolier, skipping a non-executable one', () => {
    const a = dir()
    const b = dir()
    writeFileSync(join(a, 'bardolier'), '#!/bin/sh\n', { mode: 0o644 }) // not executable
    writeFileSync(join(b, 'bardolier'), '#!/bin/sh\n', { mode: 0o755 })

    const found = findInstalled([a, b])
    assert.equal(found?.dir, b)
  })

  test('reports nothing when no directory has it', () => {
    assert.equal(findInstalled([dir(), dir()]), null)
  })
})

describe('satisfiesNodeEngine', () => {
  test('compares major.minor.patch correctly', () => {
    assert.equal(satisfiesNodeEngine('>=22.18.0', 'v22.18.0'), true)
    assert.equal(satisfiesNodeEngine('>=22.18.0', 'v22.20.0'), true)
    assert.equal(satisfiesNodeEngine('>=22.18.0', 'v24.0.0'), true)
    assert.equal(satisfiesNodeEngine('>=22.18.0', 'v22.17.9'), false)
    assert.equal(satisfiesNodeEngine('>=22.18.0', 'v20.0.0'), false)
  })
})

describe('linkOne', () => {
  test('a symlink already pointing at the target is left alone', () => {
    const binDir = dir()
    const target = shimPath()
    symlinkSync(target, join(binDir, 'bardolier'))
    const result = linkOne(binDir, 'bardolier', target, false)
    assert.equal(result.action, 'already_linked')
  })
})
