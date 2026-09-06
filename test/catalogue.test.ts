/**
 * The service catalogue: where it resolves from, and what `bardolier catalogue` reports.
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { join } from 'node:path'

import { BardolierError } from '../cli/src/errors.ts'
import { validate } from '../cli/src/schema.ts'
import { loadConfig } from '../cli/src/config.ts'
import { connectionHint, resolveCatalogue } from '../cli/src/catalogue.ts'
import { collectCatalogue } from '../cli/src/commands/catalogue.ts'
import { catalogue, makeContext, manifest, project, sandboxes } from './helpers.ts'

const sandbox = sandboxes()

describe('service catalogue resolution (cli-spec.md §4.1)', () => {
  test('falls back to the bundled default when the SSD has none', () => {
    const box = sandbox()
    const { config } = loadConfig({ path: box.configPath, home: box.home, env: { BARDOLIER_ROOT: box.root } })
    const resolved = resolveCatalogue(config)
    assert.equal(resolved.origin, 'bundled')
    assert.deepEqual(Object.keys(resolved.catalogue.services).sort(), ['mongo', 'postgres', 'redis'])
  })

  test('prefers $SSD_ROOT/services.yml over the bundled default', () => {
    const box = sandbox()
    box.writeFile(
      join('ssd', 'claude-projects', 'services.yml'),
      'services:\n  minio:\n    display: MinIO\n    image: minio/minio\n    container_port: 9000\n    host_port_base: 9000\n    mount: /data\n',
    )
    const { config } = loadConfig({ path: box.configPath, home: box.home, env: { BARDOLIER_ROOT: box.root } })
    const resolved = resolveCatalogue(config)
    assert.equal(resolved.origin, 'ssd')
    assert.deepEqual(Object.keys(resolved.catalogue.services), ['minio'])
  })

  test('a configured catalogue_path that does not exist is an error, not a silent fallback', () => {
    const box = sandbox()
    box.writeConfig({ catalogue_path: join(box.home, 'missing.yml') })
    const { config } = loadConfig({ path: box.configPath, home: box.home, env: { BARDOLIER_ROOT: box.root } })
    assert.throws(
      () => resolveCatalogue(config),
      (error: unknown) => error instanceof BardolierError && error.code === 'CONFIG_INVALID',
    )
  })

  test('a catalogue that breaks the schema is CONFIG_INVALID', () => {
    const box = sandbox()
    box.writeFile(join('ssd', 'claude-projects', 'services.yml'), 'services:\n  redis:\n    display: Redis\n')
    const { config } = loadConfig({ path: box.configPath, home: box.home, env: { BARDOLIER_ROOT: box.root } })
    assert.throws(
      () => resolveCatalogue(config),
      (error: unknown) => error instanceof BardolierError && error.code === 'CONFIG_INVALID',
    )
  })

  test('connection hints name the HOST port (the debugging tap, §5)', () => {
    assert.equal(connectionHint('postgres', { container_port: 5432 }, 5433, 'myapp'), 'postgresql://localhost:5433')
    assert.equal(connectionHint('redis', { container_port: 6379 }, 6380, 'myapp'), 'redis://localhost:6380')
    assert.equal(connectionHint('mongo', { container_port: 27017 }, 27018, 'myapp'), 'mongodb://localhost:27018')
  })

  test('an unknown service still gets a usable hint — no code change to add one', () => {
    assert.equal(connectionHint('minio', { container_port: 9000 }, 9001, 'myapp'), 'tcp://localhost:9001')
  })

  test('a catalogue-supplied template wins and interpolates', () => {
    const hint = connectionHint(
      'postgres',
      { container_port: 5432, connection_hint: 'postgresql://dev@localhost:{host_port}/{project}' },
      5440,
      'shop',
    )
    assert.equal(hint, 'postgresql://dev@localhost:5440/shop')
  })
})

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
