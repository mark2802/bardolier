/**
 * Contract tests — every command's payload against the schema documenting it:
 * status, the manifest, the catalogue, the error codes, and the rest of §6.
 * The machine half of the done-checks. Phase 4 froze these; additive only.
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml'

import { ERROR_CODES, BardolierError, isErrorCode } from '../cli/src/errors.ts'
import { SCHEMA_NAMES, loadSchema, validate } from '../cli/src/schema.ts'
import { CATALOGUE_ORIGINS } from '../cli/src/catalogue.ts'
import { CONFIG_KEYS } from '../cli/src/config.ts'
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
import type { AttachedExtraPort, PortAddOutput, PortListOutput, PortRemoveOutput } from '../cli/src/model/extraport.ts'
import type { ShellOutput } from '../cli/src/model/shell.ts'
import type { OrphanedVolume, VolumesOrphanedOutput, VolumesRemoveOutput } from '../cli/src/model/volumes.ts'
import type { DownAllOutput, EjectHolder, EjectOutput } from '../cli/src/model/ssd.ts'

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
    assert.equal(project.dev_container, 'bardolier-myapp')
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
      projects: [
        {
          name: 'idle',
          dir: '/Volumes/ssd/claude-projects/idle',
          archetype: 'ios',
          state: 'stopped',
          services: [],
          dev_container: null,
          // An `ios` project serves nothing, so §9's dev-server port is null
          // rather than absent — the app reads a field, not a maybe-field.
          app_port: null,
          app_url: null,
        },
      ],
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
      base_image: 'bardolier-web',
      created: '2026-08-19T10:00:00Z',
    }
    assert.ok(validate('project', bare).valid)
  })

  test('rejects a service entry missing its host_port', () => {
    const bad = { ...manifest, services: { postgres: {} } }
    assert.equal(validate('project', bad).valid, false)
  })

  test('accepts extra_ports (§5.1), keyed by a user-chosen name', () => {
    const withExtra = { ...manifest, extra_ports: { notebook: { container_port: 8888, host_port: 8888 } } }
    assert.ok(validate('project', withExtra).valid)
  })

  test('rejects an extra_ports entry missing either port', () => {
    const bad = { ...manifest, extra_ports: { notebook: { container_port: 8888 } } }
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
      mount: '/var/lib/postgresql/data',
      env: { POSTGRES_PASSWORD: 'dev', POSTGRES_DB: '{project}' },
    })
    assert.deepEqual(catalogue.services.redis, {
      display: 'Redis',
      image: 'redis:7',
      container_port: 6379,
      host_port_base: 6379,
      mount: '/data',
    })
    assert.deepEqual(catalogue.services.mongo, {
      display: 'MongoDB',
      image: 'mongo:7',
      container_port: 27017,
      host_port_base: 27017,
      mount: '/data/db',
    })
  })

  test('every service declares a host-port band the allocator can count from (§5)', () => {
    for (const [key, service] of Object.entries(catalogue.services)) {
      assert.ok(service.host_port_base >= 1024, `${key} band starts below 1024`)
      assert.ok(service.mount.startsWith('/'), `${key} mount is not an absolute container path`)
    }
  })

  test('no entry declares a volume — a service\'s data directory is its key (phase 19)', () => {
    const raw = parseYaml(readText('cli/defaults/services.yml')) as { services: Record<string, Record<string, unknown>> }
    for (const [key, service] of Object.entries(raw.services)) {
      assert.ok(!('volume' in service), `${key} still declares a volume`)
    }
    assert.equal(validate('services', { services: { pg: { ...raw.services.postgres, volume: 'x' } } }).valid, false)
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
    data_dir: '/Volumes/ssd/claude-projects/myapp/data/postgres',
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
      removed: { key: 'postgres', host_port: 5433, data_dir: '/Volumes/ssd/claude-projects/myapp/data/postgres' },
      services: [],
      compose_path: '/Volumes/ssd/claude-projects/myapp/docker-compose.yml',
      compose_regenerated: true,
    }
    assert.ok(validate('service-remove', remove).valid)

    const list: ServiceListOutput = { project: 'myapp', services: [attached] }
    assert.ok(validate('service-list', list).valid)
  })

  test('a detached service whose catalogue entry vanished still reports its data directory', () => {
    // The directory is named by the catalogue KEY (phase 19), so an entry the
    // catalogue has forgotten is still removable AND still locatable.
    const remove = {
      project: 'myapp',
      removed: { key: 'kafka', host_port: 9092, data_dir: '/Volumes/ssd/claude-projects/myapp/data/kafka' },
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
    const { key, display, container_port, connection_hint, data_dir } = attached
    const bad = { project: 'myapp', services: [{ key, display, container_port, connection_hint, data_dir }] }
    assert.equal(validate('service-list', bad).valid, false)
  })
})

describe('extra port contracts (cli-spec.md §6, Ports; §5.1)', () => {
  /** The row shape shared by status/port-add/port-remove/port-list. */
  const CARRIERS = ['status', 'port-add', 'port-remove', 'port-list'] as const

  const attached: AttachedExtraPort = {
    name: 'notebook',
    host_port: 8888,
    container_port: 8888,
    url: 'http://localhost:8888',
  }

  test('the attached-extra-port block is identical in every schema that carries it', () => {
    const blocks = CARRIERS.map((name) => {
      const schema = loadSchema(name) as { $defs?: { attached_extra_port?: unknown } }
      assert.ok(schema.$defs?.attached_extra_port, `${name}.schema.json has no $defs.attached_extra_port`)
      return JSON.stringify(schema.$defs.attached_extra_port)
    })
    assert.equal(new Set(blocks).size, 1, 'the duplicated $defs blocks have drifted apart')
  })

  test('the typed model satisfies the schema it is mirrored by', () => {
    const add: PortAddOutput = {
      project: 'myapp',
      added: attached,
      extra_ports: [attached],
      compose_path: '/Volumes/ssd/claude-projects/myapp/docker-compose.yml',
      compose_regenerated: true,
    }
    assert.ok(validate('port-add', add).valid, validate('port-add', add).errors.join('\n'))

    const remove: PortRemoveOutput = {
      project: 'myapp',
      removed: { name: 'notebook', host_port: 8888 },
      extra_ports: [],
      compose_path: '/Volumes/ssd/claude-projects/myapp/docker-compose.yml',
      compose_regenerated: true,
    }
    assert.ok(validate('port-remove', remove).valid)

    const list: PortListOutput = { project: 'myapp', extra_ports: [attached] }
    assert.ok(validate('port-list', list).valid)
  })

  test('a project with nothing declared is valid everywhere', () => {
    assert.ok(validate('port-list', { project: 'bare', extra_ports: [] }).valid)
  })

  test('rejects a row missing its host port — the whole point of the record (§5.1)', () => {
    const { name, container_port, url } = attached
    const bad = { project: 'myapp', extra_ports: [{ name, container_port, url }] }
    assert.equal(validate('port-list', bad).valid, false)
  })

  test('status may report extra_ports, and a project reporting none is still valid', () => {
    const withPorts = {
      name: 'myapp',
      dir: '/Volumes/ssd/claude-projects/myapp',
      archetype: 'web',
      state: 'stopped',
      services: [],
      dev_container: null,
      app_port: null,
      app_url: null,
      extra_ports: [attached],
    }
    assert.ok(validate('status', { ssd: { mounted: true, root: '/x' }, docker: { available: true }, projects: [withPorts], orphaned_volumes: [] }).valid)
  })
})

describe('config contract (cli-spec.md §8)', () => {
  test('every §8 key is accepted and every key is optional', () => {
    assert.ok(validate('config', {}).valid)
    assert.ok(
      validate('config', {
        roots: [{ name: 'ssd', path: '/Volumes/ssd/claude-projects' }],
        catalogue_path: '/Volumes/ssd/services.yml',
        terminal: 'Terminal',
      }).valid,
    )
  })

  test('rejects an unknown key so a typo cannot be silently ignored', () => {
    assert.equal(validate('config', { ssd_rooot: '/typo' }).valid, false)
  })
})

describe('catalogue + config commands (app-spec.md §6, §8, §12)', () => {
  test('catalogue origins agree with the §4.1 resolution chain in code', () => {
    const schema = loadSchema('catalogue') as { properties: { origin: { enum: string[] } } }
    assert.deepEqual([...schema.properties.origin.enum].sort(), [...CATALOGUE_ORIGINS].sort())
  })

  test('the effective-config block is identical in config-get and config-set', () => {
    const get = (loadSchema('config-get') as { $defs: Record<string, unknown> }).$defs.effective_config
    const set = (loadSchema('config-set') as { $defs: Record<string, unknown> }).$defs.effective_config
    assert.deepEqual(get, set, 'the two copies have drifted')
  })

  test('every settable key is a key the config file schema accepts, plus the list-valued `roots`', () => {
    const file = loadSchema('config') as { properties: Record<string, unknown> }
    // `roots` is a real file key but not settable through `config set` — it is
    // list-valued and has its own surface (`bardolier root add|remove|list`, phase 18).
    assert.deepEqual([...CONFIG_KEYS, 'roots'].sort(), Object.keys(file.properties).sort())
  })

  test('`config set` reports changes only for keys it can actually set', () => {
    const schema = loadSchema('config-set') as { properties: { changed: { items: { enum: string[] } } } }
    assert.deepEqual([...schema.properties.changed.items.enum].sort(), [...CONFIG_KEYS].sort())
  })

  test('the effective config carries every §8 key, catalogue_path nullable', () => {
    const effective = (loadSchema('config-get') as { $defs: { effective_config: { required: string[] } } }).$defs
      .effective_config
    assert.deepEqual([...effective.required].sort(), [...CONFIG_KEYS].sort())

    const valid = {
      path: '/home/me/.config/bardolier/config.yml',
      exists: false,
      config: { catalogue_path: null, terminal: 'Terminal' },
      overrides: [],
    }
    assert.ok(validate('config-get', valid).valid, validate('config-get', valid).errors.join('\n'))
  })

  test('a catalogue row carries the band start, and nothing that looks like an assignment', () => {
    const row = (loadSchema('catalogue') as { $defs: { catalogue_service: { properties: Record<string, unknown> } } })
      .$defs.catalogue_service.properties
    assert.ok('host_port_base' in row, 'the band start is what the app may show (§5)')
    assert.ok(!('host_port' in row), 'an assigned port comes from a manifest, never from the catalogue')
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
    const error = new BardolierError('EJECT_BLOCKED', 'The SSD is in use.', { holders: ['Xcode'] })
    const payload = error.toPayload()
    assert.deepEqual(payload, {
      error: { code: 'EJECT_BLOCKED', message: 'The SSD is in use.', details: { holders: ['Xcode'] } },
    })
    assert.ok(validate('error', payload).valid)
  })

  test('an envelope without details is valid', () => {
    const payload = new BardolierError('PROJECT_NOT_FOUND', 'No such project.').toPayload()
    assert.ok(validate('error', payload).valid)
  })
})

describe('command surface (cli-spec.md §6)', () => {
  const leaves = walk(ROOT)
  const names = leaves.map((c) => c.path.join(' '))

  /**
   * Every command §6 itself names. Phase 4 completed the original set; Phase
   * 12 extended §6 with Ports (`port add/remove/list`), Phase 13 with Deps
   * (`deps add/remove/list`), and Phase 18 with Roots (`root add/remove/list`),
   * all additively — the "declares nothing beyond §6" test below still holds
   * because §6 itself grew.
   */
  const SPEC_COMMANDS = [
    'build',
    'delete',
    'deps add',
    'deps list',
    'deps remove',
    'doctor',
    'down',
    'down-all',
    'eject',
    'list',
    'new',
    'port add',
    'port list',
    'port remove',
    'root add',
    'root list',
    'root remove',
    'service add',
    'service list',
    'service remove',
    'shell',
    'status',
    'up',
    'volumes orphaned',
    'volumes rm',
  ]

  /**
   * Commands §6 does not name, grown for the app under §1's rule that "if the
   * app needs something, a CLI command grows to provide it" (Phase 6):
   *
   *   catalogue   — the Services submenu ticks the attached rows of the WHOLE
   *                 catalogue (app-spec.md §6), and New-project offers it (§8).
   *                 The alternative was a second copy of services.yml in Swift.
   *   config get  — Preferences shows the effective config (§12) …
   *   config set  — … and writes it through the CLI, so precedence and path
   *                 expansion stay in one place.
   *
   * Additive, so the freeze holds: no existing schema changed to make room.
   */
  const APP_COMMANDS = ['catalogue', 'config get', 'config set']

  /** Commands with real behaviour — everything, since Phase 4. */
  const IMPLEMENTED = new Set([...SPEC_COMMANDS, ...APP_COMMANDS])

  test('declares every command in §6', () => {
    for (const command of SPEC_COMMANDS) {
      assert.ok(names.includes(command), `\`${command}\` is named in §6 but not declared`)
    }
  })

  test('declares nothing beyond §6 but the app-support commands', () => {
    assert.deepEqual(names.sort(), [...SPEC_COMMANDS, ...APP_COMMANDS].sort())
  })

  test('`bardolier --help` lists all of them', () => {
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
        (error: unknown) => error instanceof BardolierError && error.code === 'NOT_IMPLEMENTED',
        `\`${name}\` did not throw NOT_IMPLEMENTED`,
      )
    }
  })

  test('the implemented set matches the phases landed so far', () => {
    // Phase 1 was the read-only core; Phase 2 the project lifecycle; Phase 3
    // services and ports; Phase 4 shell, volumes, down-all and eject, which
    // completed §6 and froze the contract. Phase 6 added the app-support
    // commands above and Phase 12 the Ports group — both additively, which is
    // why the freeze survives them.
    assert.deepEqual([...IMPLEMENTED].sort(), [...names].sort())
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

describe('shell contract (cli-spec.md §6, Shell)', () => {
  test('the typed model satisfies shell.schema.json', () => {
    const shell: ShellOutput = {
      project: 'myapp',
      container: 'bardolier-myapp',
      exec: ['docker', 'exec', '-it', 'bardolier-myapp', 'bash'],
      workdir: '/work',
    }
    assert.ok(validate('shell', shell).valid)
  })

  test('`exec` is argv, never a command string — the app runs it without a shell', () => {
    const asString = { project: 'myapp', container: 'bardolier-myapp', exec: 'docker exec -it bardolier-myapp bash', workdir: '/work' }
    assert.equal(validate('shell', asString).valid, false)
    const empty = { project: 'myapp', container: 'bardolier-myapp', exec: [], workdir: '/work' }
    assert.equal(validate('shell', empty).valid, false)
  })
})

describe('volumes contracts (cli-spec.md §6, Volumes / disk)', () => {
  const orphan: OrphanedVolume = {
    name: 'oldapp_pgdata',
    size_bytes: 20971520,
    size_human: '20 MB',
    last_project: 'oldapp',
  }

  test('the orphan row is identical in status and volumes-orphaned', () => {
    const fromStatus = (loadSchema('status') as { $defs: { orphanedVolume: unknown } }).$defs.orphanedVolume
    const fromVolumes = (loadSchema('volumes-orphaned') as { $defs: { orphanedVolume: unknown } }).$defs.orphanedVolume
    assert.deepEqual(fromVolumes, fromStatus, 'the duplicated $defs blocks have drifted apart')
  })

  test('the typed models satisfy the schemas they are mirrored by', () => {
    const orphaned: VolumesOrphanedOutput = { orphaned: [orphan], total_bytes: 20971520, total_human: '20 MB' }
    assert.ok(validate('volumes-orphaned', orphaned).valid)

    const removed: VolumesRemoveOutput = {
      volume: 'oldapp_pgdata',
      removed: true,
      size_bytes: 20971520,
      size_human: '20 MB',
      last_project: 'oldapp',
    }
    assert.ok(validate('volumes-rm', removed).valid)
  })

  test('nothing to reclaim is a valid answer, not an absent one', () => {
    assert.ok(validate('volumes-orphaned', { orphaned: [], total_bytes: 0, total_human: '0 B' }).valid)
  })

  test('an unattributable volume may report a null last_project', () => {
    const anonymous = { ...orphan, last_project: null }
    assert.ok(validate('volumes-orphaned', { orphaned: [anonymous], total_bytes: 0, total_human: '0 B' }).valid)
    const { name, ...rest } = anonymous
    assert.ok(validate('volumes-rm', { ...rest, volume: name, removed: false }).valid)
  })

  test('rejects a row missing its size — the whole point of the listing', () => {
    const bad = { orphaned: [{ name: 'x', size_human: '1 MB', last_project: null }], total_bytes: 0, total_human: '0 B' }
    assert.equal(validate('volumes-orphaned', bad).valid, false)
  })
})

describe('down-all and eject contracts (cli-spec.md §6, Lifecycle / SSD)', () => {
  test('the typed models satisfy the schemas they are mirrored by', () => {
    const downAll: DownAllOutput = {
      projects: [
        { name: 'alpha', was_running: true },
        { name: 'beta', was_running: false },
      ],
      stopped: ['alpha'],
      stray_containers: ['bardolier-ghost'],
      docker_available: true,
    }
    assert.ok(validate('down-all', downAll).valid)

    const eject: EjectOutput = {
      volume: '/Volumes/ssd',
      ejected: true,
      stopped: ['alpha'],
      holders: [],
      docker_stopped: false,
    }
    assert.ok(validate('eject', eject).valid)
  })

  test('a daemon-less down-all is a no-op success, not a failure', () => {
    const offline: DownAllOutput = { projects: [], stopped: [], stray_containers: [], docker_available: false }
    assert.ok(validate('down-all', offline).valid)
  })

  test('`ejected` cannot be false — a refusal is EJECT_BLOCKED, not a payload', () => {
    assert.equal(validate('eject', { volume: '/Volumes/ssd', ejected: false, stopped: [], holders: [] }).valid, false)
  })

  test('the EJECT_BLOCKED envelope carries holders the app can render (§13)', () => {
    const holders: EjectHolder[] = [{ pid: 431, command: 'Xcode', user: 'mark', paths: ['/Volumes/ssd/claude-projects'] }]
    const payload = new BardolierError('EJECT_BLOCKED', 'The SSD is held.', { holders }).toPayload()
    assert.ok(validate('error', payload).valid)
    assert.deepEqual(payload.error.details?.holders, holders)
    // The same shape the success payload declares, so the app decodes one type.
    assert.ok(validate('eject', { volume: '/Volumes/ssd', ejected: true, stopped: [], holders }).valid)
  })

  test('a holder with an unknown user is still a holder', () => {
    const holder = { pid: 1, command: 'launchd', user: null, paths: [] }
    assert.ok(validate('eject', { volume: '/Volumes/ssd', ejected: true, stopped: [], holders: [holder] }).valid)
  })
})
