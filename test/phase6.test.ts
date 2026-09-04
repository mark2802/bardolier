/**
 * Phase 6 — the two commands the app needed and the field it needed. Most of
 * the phase is a human clicking a menu; the CLI surface it grew is testable,
 * and each part exists so the app holds no second copy of a CLI decision:
 *   - `catalogue` reports the file that ACTUALLY answered (§4.1's chain).
 *   - `config set` goes through config.ts, so the app inherits §8's precedence,
 *     path expansion and ordering.
 *   - `config get` reports env overrides, so Preferences can say "the
 *     environment wins here" instead of writing a value with no effect.
 *   - `status.dir` is reported, not composed, so the app never encodes §3.
 */

import { test, describe, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { parse as parseYaml } from 'yaml'

import { BardolierError } from '../cli/src/errors.ts'
import { validate } from '../cli/src/schema.ts'
import { collectCatalogue } from '../cli/src/commands/catalogue.ts'
import { collectConfigGet, runConfigSet } from '../cli/src/commands/config.ts'
import { collectStatus } from '../cli/src/commands/status.ts'
import { runNew } from '../cli/src/commands/new.ts'
import { makeContext, makeSandbox, manifest, stubDocker, type Sandbox } from './helpers.ts'

const sandboxes: Sandbox[] = []
function sandbox(): Sandbox {
  const created = makeSandbox()
  sandboxes.push(created)
  return created
}
afterEach(() => {
  while (sandboxes.length > 0) sandboxes.pop()?.cleanup()
})

/** A context whose config comes from the FILE, not from the test env (§8). */
function fileConfigured(box: Sandbox) {
  return makeContext(box, stubDocker(), { env: { BDLR_SSD_ROOT: '' } })
}

describe('catalogue (app-spec.md §6, §8)', () => {
  test('lists every service the catalogue defines, sorted, schema-valid', () => {
    const output = collectCatalogue(makeContext(sandbox()))

    assert.ok(validate('catalogue', output).valid, validate('catalogue', output).errors.join('\n'))
    const keys = output.services.map((service) => service.key)
    assert.deepEqual(keys, [...keys].sort())
    assert.ok(keys.includes('postgres'), 'the bundled catalogue defines postgres')
  })

  test('reports the file that actually answered, not where it might have been', () => {
    const box = sandbox()
    const bundled = collectCatalogue(makeContext(box))
    assert.equal(bundled.origin, 'bundled')

    // §4.1: a services.yml on the SSD wins over the bundled default.
    box.writeFile('ssd/claude-projects/services.yml', [
      'services:',
      '  clickhouse:',
      '    display: "ClickHouse"',
      '    image: "clickhouse/clickhouse-server:24"',
      '    container_port: 9000',
      '    host_port_base: 9000',
      '    volume: "{project}_chdata"',
      '    mount: /var/lib/clickhouse',
    ].join('\n'))

    const onSsd = collectCatalogue(makeContext(box))
    assert.equal(onSsd.origin, 'ssd')
    assert.deepEqual(onSsd.services.map((s) => s.key), ['clickhouse'])
    assert.equal(onSsd.services[0]?.display, 'ClickHouse')
  })

  test('reports the BAND start, never a port a project holds (§5)', () => {
    const box = sandbox()
    // postgres:5432 is the band start; this project already sits on 5433.
    box.writeProject('myapp', manifest('myapp', { services: { postgres: { host_port: 5433 } } }))

    const row = collectCatalogue(makeContext(box)).services.find((service) => service.key === 'postgres')
    assert.ok(row)
    assert.equal(row.host_port_base, 5432, 'the band start is a definition, not an allocation')
  })

  test('a broken catalogue fails CONFIG_INVALID rather than reporting an empty one', () => {
    const box = sandbox()
    box.writeFile('ssd/claude-projects/services.yml', 'services:\n  postgres:\n    display: 12\n')

    assert.throws(
      () => collectCatalogue(makeContext(box)),
      (error: unknown) => error instanceof BardolierError && error.code === 'CONFIG_INVALID',
    )
  })
})

describe('config get (app-spec.md §12)', () => {
  test('reports the effective config and the file it came from', () => {
    const box = sandbox()
    box.writeConfig({ ssd_volume: '/Volumes/other', terminal: 'iTerm' })

    const output = collectConfigGet(fileConfigured(box))

    assert.ok(validate('config-get', output).valid, validate('config-get', output).errors.join('\n'))
    assert.equal(output.path, box.configPath)
    assert.equal(output.exists, true)
    assert.equal(output.config.terminal, 'iTerm')
    assert.equal(output.config.ssd_volume, '/Volumes/other')
    // §8: the root defaults INSIDE the volume, so one setting moves both.
    assert.equal(output.config.ssd_root, '/Volumes/other/claude-projects')
    assert.deepEqual(output.overrides, [])
  })

  test('an absent file is a valid answer, not a failure (first run)', () => {
    const output = collectConfigGet(fileConfigured(sandbox()))
    assert.equal(output.exists, false)
    assert.ok(validate('config-get', output).valid)
    assert.equal(output.config.terminal, 'Terminal')
  })

  test('names the environment overrides, so Preferences can say the file cannot win', () => {
    const box = sandbox()
    const output = collectConfigGet(makeContext(box))
    assert.deepEqual(output.overrides, ['BDLR_SSD_ROOT'])
    assert.equal(output.config.ssd_root, box.root)
  })
})

describe('config set (app-spec.md §12)', () => {
  test('creates the file, records what changed, and reports the config after', () => {
    const box = sandbox()
    const output = runConfigSet(fileConfigured(box), { key: 'terminal', value: 'Ghostty' })

    assert.ok(validate('config-set', output).valid, validate('config-set', output).errors.join('\n'))
    assert.equal(output.created, true)
    assert.deepEqual(output.changed, ['terminal'])
    assert.equal(output.config.terminal, 'Ghostty')
    assert.deepEqual(parseYaml(readFileSync(box.configPath, 'utf8')), { terminal: 'Ghostty' })
  })

  test('writing the same value again changes nothing', () => {
    const box = sandbox()
    runConfigSet(fileConfigured(box), { key: 'terminal', value: 'Ghostty' })
    const before = readFileSync(box.configPath, 'utf8')

    const again = runConfigSet(fileConfigured(box), { key: 'terminal', value: 'Ghostty' })

    assert.deepEqual(again.changed, [])
    assert.equal(again.created, false)
    assert.equal(readFileSync(box.configPath, 'utf8'), before, 'a no-op write must not rewrite the file')
  })

  test('paths are expanded on the way in, so the stored value is the one used', () => {
    const box = sandbox()
    const output = runConfigSet(fileConfigured(box), { key: 'ssd_volume', value: '~/ssd' })

    assert.equal(output.config.ssd_volume, `${box.home}/ssd`)
    assert.equal((parseYaml(readFileSync(box.configPath, 'utf8')) as { ssd_volume: string }).ssd_volume, `${box.home}/ssd`)
  })

  test('an empty value clears the key rather than storing an empty string', () => {
    const box = sandbox()
    box.writeConfig({ catalogue_path: '/tmp/services.yml', terminal: 'iTerm' })

    const output = runConfigSet(fileConfigured(box), { key: 'catalogue_path', value: '' })

    assert.deepEqual(output.changed, ['catalogue_path'])
    assert.equal(output.config.catalogue_path, null)
    assert.deepEqual(parseYaml(readFileSync(box.configPath, 'utf8')), { terminal: 'iTerm' })
  })

  test('keys are written in a stable order, so two writes give the same bytes', () => {
    const first = sandbox()
    runConfigSet(fileConfigured(first), { key: 'terminal', value: 'iTerm' })
    runConfigSet(fileConfigured(first), { key: 'ssd_volume', value: '/Volumes/ssd' })

    const second = sandbox()
    runConfigSet(fileConfigured(second), { key: 'ssd_volume', value: '/Volumes/ssd' })
    runConfigSet(fileConfigured(second), { key: 'terminal', value: 'iTerm' })

    assert.equal(readFileSync(first.configPath, 'utf8'), readFileSync(second.configPath, 'utf8'))
  })

  test('an unknown key is INVALID_ARGUMENT and touches nothing', () => {
    const box = sandbox()
    assert.throws(
      () => runConfigSet(fileConfigured(box), { key: 'ssd_rooot', value: '/x' }),
      (error: unknown) => error instanceof BardolierError && error.code === 'INVALID_ARGUMENT',
    )
    assert.equal(box.exists('..', 'config.yml'), false)
  })

  test('an overridden key is still written, and the override is still reported', () => {
    const box = sandbox()
    // BDLR_SSD_ROOT is set by makeContext, so the file cannot win here.
    const output = runConfigSet(makeContext(box), { key: 'ssd_root', value: '/Volumes/elsewhere/projects' })

    assert.deepEqual(output.changed, ['ssd_root'])
    assert.deepEqual(output.overrides, ['BDLR_SSD_ROOT'])
    assert.equal(output.config.ssd_root, box.root, 'the environment still wins for the effective value')
  })
})

describe('status.dir (app-spec.md §5, "Open folder in Finder")', () => {
  test('every project reports its own directory', async () => {
    const box = sandbox()
    const ctx = makeContext(box)
    await runNew(ctx, { name: 'myapp', archetype: 'web', services: undefined })

    const status = await collectStatus(ctx)
    const project = status.projects.find((p) => p.name === 'myapp')

    assert.ok(project)
    assert.equal(project.dir, box.path('myapp'))
    assert.ok(validate('status', status).valid, validate('status', status).errors.join('\n'))
  })
})
