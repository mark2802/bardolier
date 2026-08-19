/**
 * Phase 0 contract tests.
 *
 * These guard the things the app will depend on from Phase 5 onward: the status
 * schema, the manifest schema, the catalogue, and the error-code list. They are
 * the machine half of the done-check — `test/phase0-done-check.sh` runs them.
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml'

import { ERROR_CODES, CprojError, isErrorCode } from '../cli/src/errors.ts'
import { SCHEMA_NAMES, loadSchema, validate } from '../cli/src/schema.ts'
import { ARCHETYPES, ARCHETYPE_BASE_IMAGE } from '../cli/src/model/archetype.ts'
import { COMMANDS, ROOT, walk } from '../cli/src/commands/registry.ts'
import { renderRootHelp } from '../cli/src/render/human.ts'
import type { Status } from '../cli/src/model/status.ts'
import type { ProjectManifest } from '../cli/src/model/project.ts'
import type { ServiceCatalogue } from '../cli/src/model/catalogue.ts'

const repo = (p: string) => fileURLToPath(new URL(`../${p}`, import.meta.url))
const readText = (p: string) => readFileSync(repo(p), 'utf8')

describe('schemas', () => {
  test('every schema file parses and compiles', () => {
    for (const name of SCHEMA_NAMES) {
      const schema = loadSchema(name)
      assert.equal(typeof schema, 'object', `${name} did not parse to an object`)
      // Compiling proves the schema itself is well-formed, not just valid JSON.
      const result = validate(name, undefined)
      assert.equal(typeof result.valid, 'boolean')
    }
  })
})

describe('status contract (cli-spec.md §7)', () => {
  const raw = readText('test/fixtures/status.example.json')
  const fixture = JSON.parse(raw) as Status

  test('the §7 example validates against status.schema.json', () => {
    const { valid, errors } = validate('status', fixture)
    assert.ok(valid, `fixture failed validation:\n${errors.join('\n')}`)
  })

  test('round-trips through the typed model without loss', () => {
    const typed: Status = fixture
    const roundTripped = JSON.parse(JSON.stringify(typed)) as Status
    assert.deepEqual(roundTripped, fixture)
    assert.ok(validate('status', roundTripped).valid)
  })

  test('carries the §7 field values verbatim', () => {
    assert.equal(fixture.ssd.root, '/Volumes/ssd/claude-projects')
    const project = fixture.projects[0]
    assert.ok(project)
    assert.equal(project.name, 'myapp')
    assert.equal(project.dev_container, 'cproj-myapp')
    const service = project.services[0]
    assert.ok(service)
    assert.equal(service.host_port, 5433)
    assert.equal(service.container_port, 5432)
    assert.equal(service.connection_hint, 'postgresql://localhost:5433')
    const orphan = fixture.orphaned_volumes[0]
    assert.ok(orphan)
    assert.equal(orphan.size_bytes, 20971520)
  })

  test('a stopped project may report dev_container: null', () => {
    const stopped: Status = {
      ssd: { mounted: false, root: '/Volumes/ssd/claude-projects' },
      docker: { available: false },
      projects: [{ name: 'idle', archetype: 'ios', state: 'stopped', services: [], dev_container: null }],
      orphaned_volumes: [],
    }
    assert.ok(validate('status', stopped).valid)
  })

  test('empty status (no projects, no orphans) is valid', () => {
    const empty: Status = {
      ssd: { mounted: false, root: '/Volumes/ssd/claude-projects' },
      docker: { available: true },
      projects: [],
      orphaned_volumes: [],
    }
    assert.ok(validate('status', empty).valid)
  })

  test('rejects an unknown project state', () => {
    const bad = JSON.parse(raw) as Record<string, unknown>
    const projects = bad.projects as Record<string, unknown>[]
    projects[0]!.state = 'sleeping'
    assert.equal(validate('status', bad).valid, false)
  })
})

describe('project manifest contract (cli-spec.md §4.2)', () => {
  const source = readText('test/fixtures/project.example.yml')
  const manifest = parseYaml(source) as ProjectManifest

  test('the §4.2 example validates against project.schema.json', () => {
    const { valid, errors } = validate('project', manifest)
    assert.ok(valid, `manifest failed validation:\n${errors.join('\n')}`)
  })

  test('round-trips through YAML without loss', () => {
    const roundTripped = parseYaml(stringifyYaml(manifest)) as ProjectManifest
    assert.deepEqual(roundTripped, manifest)
    assert.ok(validate('project', roundTripped).valid)
  })

  test('records assigned host ports (the single source of truth, §5)', () => {
    assert.equal(manifest.services?.postgres?.host_port, 5433)
    assert.equal(manifest.services?.redis?.host_port, 6379)
  })

  test('base_image agrees with the archetype map (§4.3)', () => {
    assert.equal(manifest.base_image, ARCHETYPE_BASE_IMAGE[manifest.archetype])
  })

  test('a manifest with no services is valid', () => {
    const bare: ProjectManifest = {
      name: 'bare',
      archetype: 'library',
      base_image: 'claude-web',
      created: '2026-08-19T10:00:00Z',
    }
    assert.ok(validate('project', bare).valid)
  })

  test('rejects a service entry missing its host_port', () => {
    const bad = { ...manifest, services: { postgres: {} } }
    assert.equal(validate('project', bad).valid, false)
  })
})

describe('service catalogue (cli-spec.md §4.1)', () => {
  const catalogue = parseYaml(readText('cli/defaults/services.yml')) as ServiceCatalogue

  test('the bundled default parses and validates', () => {
    const { valid, errors } = validate('services', catalogue)
    assert.ok(valid, `catalogue failed validation:\n${errors.join('\n')}`)
  })

  test('ships postgres, redis and mongo exactly as §4.1 specifies', () => {
    assert.deepEqual(Object.keys(catalogue.services), ['postgres', 'redis', 'mongo'])
    assert.deepEqual(catalogue.services.postgres, {
      display: 'PostgreSQL',
      image: 'postgres:17',
      container_port: 5432,
      host_port_base: 5432,
      volume: '{project}_pgdata',
      mount: '/var/lib/postgresql/data',
      env: { POSTGRES_PASSWORD: 'dev', POSTGRES_DB: '{project}' },
    })
    assert.deepEqual(catalogue.services.redis, {
      display: 'Redis',
      image: 'redis:7',
      container_port: 6379,
      host_port_base: 6379,
      volume: '{project}_redisdata',
      mount: '/data',
    })
    assert.deepEqual(catalogue.services.mongo, {
      display: 'MongoDB',
      image: 'mongo:7',
      container_port: 27017,
      host_port_base: 27017,
      volume: '{project}_mongodata',
      mount: '/data/db',
    })
  })

  test('every service declares a host-port band the allocator can count from (§5)', () => {
    for (const [key, service] of Object.entries(catalogue.services)) {
      assert.ok(service.host_port_base >= 1024, `${key} band starts below 1024`)
      assert.ok(service.volume.includes('{project}'), `${key} volume is not project-scoped`)
    }
  })
})

describe('error codes (cli-spec.md §2)', () => {
  test('every code named in §2 is defined', () => {
    const spec = [
      'SSD_NOT_MOUNTED',
      'PROJECT_EXISTS',
      'PROJECT_NOT_FOUND',
      'PROJECT_RUNNING',
      'PROJECT_STOPPED',
      'SERVICE_UNKNOWN',
      'SERVICE_ATTACHED',
      'SERVICE_NOT_ATTACHED',
      'PORT_UNAVAILABLE',
      'VOLUME_IN_USE',
      'EJECT_BLOCKED',
      'DOCKER_UNAVAILABLE',
    ]
    for (const code of spec) assert.ok(isErrorCode(code), `${code} is missing from ERROR_CODES`)
  })

  test('the list is defined in exactly one place — the schema mirrors the code', () => {
    const schema = loadSchema('error') as {
      properties: { error: { properties: { code: { enum: string[] } } } }
    }
    assert.deepEqual(schema.properties.error.properties.code.enum, [...ERROR_CODES])
  })

  test('codes are unique', () => {
    assert.equal(new Set(ERROR_CODES).size, ERROR_CODES.length)
  })

  test('a failure serialises to the §2 envelope', () => {
    const error = new CprojError('EJECT_BLOCKED', 'The SSD is in use.', { holders: ['Xcode'] })
    const payload = error.toPayload()
    assert.deepEqual(payload, {
      error: { code: 'EJECT_BLOCKED', message: 'The SSD is in use.', details: { holders: ['Xcode'] } },
    })
    assert.ok(validate('error', payload).valid)
  })

  test('an envelope without details is valid', () => {
    const payload = new CprojError('PROJECT_NOT_FOUND', 'No such project.').toPayload()
    assert.ok(validate('error', payload).valid)
  })
})

describe('command surface (cli-spec.md §6)', () => {
  const leaves = walk(ROOT)
  const names = leaves.map((c) => c.path.join(' '))

  test('declares every command in §6', () => {
    assert.deepEqual(names.sort(), [
      'build',
      'delete',
      'doctor',
      'down',
      'down-all',
      'eject',
      'list',
      'new',
      'service add',
      'service list',
      'service remove',
      'shell',
      'status',
      'up',
      'volumes orphaned',
      'volumes rm',
    ])
  })

  test('`cproj --help` lists all of them', () => {
    const help = renderRootHelp(ROOT).join('\n')
    for (const command of leaves) {
      assert.ok(help.includes(command.usage), `--help is missing \`${command.usage}\``)
    }
  })

  test('every declared error code is a real code', () => {
    const declaring = [...COMMANDS, ...leaves]
    for (const command of declaring) {
      for (const code of command.errors) {
        assert.ok(isErrorCode(code), `\`${command.path.join(' ')}\` declares unknown code ${code}`)
      }
    }
  })

  test('every command is still a stub', async () => {
    for (const command of leaves) {
      await assert.rejects(
        async () => command.run({ args: [], flags: {} }),
        (error: unknown) => error instanceof CprojError && error.code === 'NOT_IMPLEMENTED',
        `\`${command.path.join(' ')}\` did not throw NOT_IMPLEMENTED`,
      )
    }
  })
})

describe('archetypes (cli-spec.md §4.3)', () => {
  test('every archetype maps to a base image accepted by the manifest schema', () => {
    const schema = loadSchema('project') as {
      properties: { base_image: { enum: string[] }; archetype: { enum: string[] } }
    }
    assert.deepEqual(schema.properties.archetype.enum, [...ARCHETYPES])
    for (const archetype of ARCHETYPES) {
      assert.ok(schema.properties.base_image.enum.includes(ARCHETYPE_BASE_IMAGE[archetype]))
    }
  })
})
