/**
 * The no-attribution default `up` writes into `home/` — `cli-spec.md` §6, §9, phase 39.
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { ensureAttributionDefault } from '../cli/src/agent-settings.ts'
import { holdsData } from '../cli/src/layout.ts'
import { tempDirs } from './helpers.ts'

const tmp = tempDirs('bardolier-agent-settings-')
const settings = (home: string) => join(home, '.claude', 'settings.json')
const read = (home: string) => JSON.parse(readFileSync(settings(home), 'utf8'))

describe('attribution default (phase 39)', () => {
  test('a missing file is created with empty commit and pr attribution', () => {
    const home = tmp()
    assert.equal(ensureAttributionDefault(home), true)
    assert.deepEqual(read(home), { attribution: { commit: '', pr: '' } })
  })

  test('other keys are kept', () => {
    const home = tmp()
    mkdirSync(join(home, '.claude'))
    writeFileSync(settings(home), '{"model":"opus"}')
    assert.equal(ensureAttributionDefault(home), true)
    assert.deepEqual(read(home), { model: 'opus', attribution: { commit: '', pr: '' } })
  })

  test('an existing attribution key is left byte-identical, so a project can opt back in', () => {
    const home = tmp()
    mkdirSync(join(home, '.claude'))
    const text = '{"attribution":{"commit":"mine"}}'
    writeFileSync(settings(home), text)
    assert.equal(ensureAttributionDefault(home), false)
    assert.equal(readFileSync(settings(home), 'utf8'), text)
  })

  test('invalid JSON is left alone', () => {
    const home = tmp()
    mkdirSync(join(home, '.claude'))
    writeFileSync(settings(home), '{oops')
    assert.equal(ensureAttributionDefault(home), false)
    assert.equal(readFileSync(settings(home), 'utf8'), '{oops')
  })

  test('a second run writes nothing', () => {
    const home = tmp()
    ensureAttributionDefault(home)
    assert.equal(ensureAttributionDefault(home), false)
  })

  test('the untouched default is not data for delete; an edited one is', () => {
    const dir = tmp()
    const home = join(dir, 'home')
    mkdirSync(join(dir, 'data'))
    ensureAttributionDefault(home)
    assert.equal(holdsData(dir), false)
    writeFileSync(settings(home), '{"attribution":{"commit":"x"}}')
    assert.equal(holdsData(dir), true)
  })
})
