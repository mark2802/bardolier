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
import { DOCTOR_CHECKS, type DoctorReport } from '../cli/src/model/doctor.ts'
import type { ListOutput } from '../cli/src/model/list.ts'
import { COMMANDS, ROOT, walk } from '../cli/src/commands/registry.ts'
import { renderRootHelp } from '../cli/src/render/human.ts'
import type { Status } from '../cli/src/model/status.ts'
import type { ProjectManifest } from '../cli/src/model/project.ts'
import type { ServiceCatalogue } from '../cli/src/model/catalogue.ts'
import type {
  AttachedService,
  ServiceAddOutput,
  ServiceListOutput,
  ServiceRemoveOutput,
} from '../cli/src/model/service.ts'

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

describe('doctor contract (cli-spec.md §6)', () => {
  const fixture = JSON.parse(readText('test/fixtures/doctor.example.json')) as DoctorReport

  test('the example report validates against doctor.schema.json', () => {
    const { valid, errors } = validate('doctor', fixture)
    assert.ok(valid, `fixture failed validation:\n${errors.join('\n')}`)
  })

  test('the schema mirrors the check ids defined in code', () => {
    const schema = loadSchema('doctor') as {
      $defs: { finding: { properties: { id: { enum: string[] } } } }
    }
    assert.deepEqual(schema.$defs.finding.properties.id.enum, [...DOCTOR_CHECKS])
  })

  test('a failing finding carries a remedy and flips the top-level ok', () => {
    const failing = fixture.findings.find((f) => !f.ok)
    assert.ok(failing)
    assert.ok(failing.remedy)
    assert.equal(fixture.ok, false)
  })

  test('an all-ok report with no findings is valid (nothing to check is not a failure)', () => {
    assert.ok(validate('doctor', { ok: true, findings: [] }).valid)
  })

  test('rejects an unknown check id', () => {
    const bad = { ok: true, findings: [{ id: 'vibes', title: 'Vibes', ok: true, detail: 'good' }] }
    assert.equal(validate('doctor', bad).valid, false)
  })
})

describe('list contract (cli-spec.md §6)', () => {
  test('an empty list is valid', () => {
    const empty: ListOutput = { projects: [] }
    assert.ok(validate('list', empty).valid)
  })

  test('archetypes agree with the archetype model', () => {
    const schema = loadSchema('list') as {
      properties: { projects: { items: { properties: { archetype: { enum: string[] } } } } }
    }
    assert.deepEqual(schema.properties.projects.items.properties.archetype.enum, [...ARCHETYPES])
  })

  test('rejects a project missing its state', () => {
    assert.equal(validate('list', { projects: [{ name: 'a', archetype: 'web' }] }).valid, false)
  })
})

describe('service contracts (cli-spec.md §6, Services)', () => {
  /** The one row shape shared by new/service-add/service-remove/service-list. */
  const CARRIERS = ['new', 'service-add', 'service-remove', 'service-list'] as const

  const attached: AttachedService = {
    key: 'postgres',
    display: 'PostgreSQL',
    host_port: 5433,
    container_port: 5432,
    connection_hint: 'postgresql://localhost:5433',
    volume: 'myapp_pgdata',
  }

  test('the attached-service block is identical in every schema that carries it', () => {
    const blocks = CARRIERS.map((name) => {
      const schema = loadSchema(name) as { $defs?: { attached_service?: unknown } }
      assert.ok(schema.$defs?.attached_service, `${name}.schema.json has no $defs.attached_service`)
      return JSON.stringify(schema.$defs.attached_service)
    })
    assert.equal(new Set(blocks).size, 1, 'the duplicated $defs blocks have drifted apart')
  })

  test('the typed model satisfies the schema it is mirrored by', () => {
    const add: ServiceAddOutput = {
      project: 'myapp',
      added: attached,
      services: [attached],
      compose_path: '/Volumes/ssd/claude-projects/myapp/docker-compose.yml',
      compose_regenerated: true,
    }
    assert.ok(validate('service-add', add).valid)

    const remove: ServiceRemoveOutput = {
      project: 'myapp',
      removed: { key: 'postgres', host_port: 5433, volume: 'myapp_pgdata' },
      services: [],
      compose_path: '/Volumes/ssd/claude-projects/myapp/docker-compose.yml',
      compose_regenerated: true,
    }
    assert.ok(validate('service-remove', remove).valid)

    const list: ServiceListOutput = { project: 'myapp', services: [attached] }
    assert.ok(validate('service-list', list).valid)
  })

  test('a detached service whose catalogue entry vanished may report a null volume', () => {
    const remove = {
      project: 'myapp',
      removed: { key: 'kafka', host_port: 9092, volume: null },
      services: [],
      compose_path: '/tmp/docker-compose.yml',
      compose_regenerated: true,
    }
    assert.ok(validate('service-remove', remove).valid)
  })

  test('a project with nothing attached is valid everywhere', () => {
    assert.ok(validate('service-list', { project: 'bare', services: [] }).valid)
  })

  test('rejects a row missing its host port — the whole point of the record (§5)', () => {
    const { key, display, container_port, connection_hint, volume } = attached
    const bad = { project: 'myapp', services: [{ key, display, container_port, connection_hint, volume }] }
    assert.equal(validate('service-list', bad).valid, false)
  })
})

describe('config contract (cli-spec.md §8)', () => {
  test('every §8 key is accepted and every key is optional', () => {
    assert.ok(validate('config', {}).valid)
    assert.ok(
      validate('config', {
        ssd_root: '/Volumes/ssd/claude-projects',
        ssd_volume: '/Volumes/ssd',
        catalogue_path: '/Volumes/ssd/services.yml',
        terminal: 'Terminal',
      }).valid,
    )
  })

  test('rejects an unknown key so a typo cannot be silently ignored', () => {
    assert.equal(validate('config', { ssd_rooot: '/typo' }).valid, false)
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
  /**
   * Commands with real behaviour. Phase 1: read-only core. Phase 2: lifecycle.
   * Phase 3: services and port allocation.
   */
  const IMPLEMENTED = new Set([
    'status',
    'list',
    'doctor',
    'new',
    'up',
    'down',
    'delete',
    'build',
    'service add',
    'service remove',
    'service list',
  ])

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

  test('every command not yet built is still a stub', async () => {
    for (const command of leaves) {
      const name = command.path.join(' ')
      if (IMPLEMENTED.has(name)) continue
      await assert.rejects(
        async () => command.run({ args: [], flags: {}, json: false }),
        (error: unknown) => error instanceof CprojError && error.code === 'NOT_IMPLEMENTED',
        `\`${name}\` did not throw NOT_IMPLEMENTED`,
      )
    }
  })

  test('the implemented set matches the phases landed so far', () => {
    // Phase 1 was the read-only core; Phase 2 the project lifecycle; Phase 3
    // services and ports. Phase 4 adds shell, volumes, down-all and eject.
    // Update this list as each phase lands so an accidentally-live command
    // can't slip through.
    assert.deepEqual(
      [...IMPLEMENTED].sort(),
      [
        'build',
        'delete',
        'doctor',
        'down',
        'list',
        'new',
        'service add',
        'service list',
        'service remove',
        'status',
        'up',
      ],
    )
    for (const name of IMPLEMENTED) {
      assert.ok(names.includes(name), `${name} is not a declared command`)
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
