/**
 * Phase 1 — the read-only core: config, discovery, Docker probe, status, list,
 * doctor. No SSD, no daemon. Two properties the app depends on from Phase 5:
 * `status` succeeds in EVERY degraded state and always matches §7, and
 * read-only means read-only — nothing under the sandbox is created.
 */

import { test, describe, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

import { BardolierError } from '../cli/src/errors.ts'
import { validate } from '../cli/src/schema.ts'
import { DEFAULT_SSD_VOLUME, DEFAULT_TERMINAL, defaultConfigPath, loadConfig } from '../cli/src/config.ts'
import { createDocker, type DockerRunner } from '../cli/src/docker.ts'
import { connectionHint, resolveCatalogue } from '../cli/src/catalogue.ts'
import { discoverProjects, probeSsd } from '../cli/src/projects.ts'
import { devContainerName, serviceContainerName } from '../cli/src/naming.ts'
import { collectStatus } from '../cli/src/commands/status.ts'
import { collectList } from '../cli/src/commands/list.ts'
import { collectDoctor } from '../cli/src/commands/doctor.ts'
import { DOCTOR_CHECKS, type DoctorCheck, type DoctorReport } from '../cli/src/model/doctor.ts'
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

function finding(report: DoctorReport, id: DoctorCheck) {
  const found = report.findings.find((f) => f.id === id)
  assert.ok(found, `doctor produced no \`${id}\` finding`)
  return found
}

describe('config (cli-spec.md §8)', () => {
  test('loads with no config file at all — the SSD-absent first run', () => {
    const box = sandbox()
    const loaded = loadConfig({ path: join(box.home, 'nope', 'config.yml'), home: box.home, env: {} })
    assert.equal(loaded.exists, false)
    assert.equal(loaded.config.ssd_volume, DEFAULT_SSD_VOLUME)
    assert.equal(loaded.config.ssd_root, join(DEFAULT_SSD_VOLUME, 'claude-projects'))
    assert.equal(loaded.config.terminal, DEFAULT_TERMINAL)
    assert.equal(loaded.config.catalogue_path, null)
  })

  test('reads every §8 key from the file', () => {
    const box = sandbox()
    box.writeConfig({
      ssd_root: '/mnt/disk/projects',
      ssd_volume: '/mnt/disk',
      catalogue_path: '/mnt/disk/services.yml',
      terminal: 'Ghostty',
    })
    const { config } = loadConfig({ path: box.configPath, home: box.home, env: {} })
    assert.equal(config.ssd_root, '/mnt/disk/projects')
    assert.equal(config.ssd_volume, '/mnt/disk')
    assert.equal(config.catalogue_path, '/mnt/disk/services.yml')
    assert.equal(config.terminal, 'Ghostty')
  })

  test('env overrides beat the file and are reported', () => {
    const box = sandbox()
    box.writeConfig({ ssd_root: '/mnt/disk/projects', ssd_volume: '/mnt/disk' })
    const loaded = loadConfig({
      path: box.configPath,
      home: box.home,
      env: { BDLR_SSD_ROOT: '/elsewhere/projects', BDLR_SSD_VOLUME: '/elsewhere' },
    })
    assert.equal(loaded.config.ssd_root, '/elsewhere/projects')
    assert.equal(loaded.config.ssd_volume, '/elsewhere')
    assert.deepEqual([...loaded.overrides], ['BDLR_SSD_ROOT', 'BDLR_SSD_VOLUME'])
  })

  test('the root defaults inside the configured volume, so the two cannot diverge', () => {
    const box = sandbox()
    box.writeConfig({ ssd_volume: '/mnt/other' })
    const { config } = loadConfig({ path: box.configPath, home: box.home, env: {} })
    assert.equal(config.ssd_root, '/mnt/other/claude-projects')
  })

  test('expands ~ against the resolved home', () => {
    const box = sandbox()
    box.writeConfig({ ssd_root: '~/projects' })
    const { config } = loadConfig({ path: box.configPath, home: box.home, env: {} })
    assert.equal(config.ssd_root, join(box.home, 'projects'))
  })

  test('an empty file is equivalent to no file', () => {
    const box = sandbox()
    box.writeFile('empty.yml', '')
    const { config } = loadConfig({ path: join(box.home, '..', 'empty.yml'), home: box.home, env: {} })
    assert.equal(config.ssd_volume, DEFAULT_SSD_VOLUME)
  })

  test('rejects an unknown key rather than ignoring a typo', () => {
    const box = sandbox()
    box.writeConfig({ ssd_rooot: '/typo' })
    assert.throws(
      () => loadConfig({ path: box.configPath, home: box.home, env: {} }),
      (error: unknown) => error instanceof BardolierError && error.code === 'CONFIG_INVALID',
    )
  })

  test('rejects unparseable YAML with CONFIG_INVALID', () => {
    const box = sandbox()
    const path = box.writeFile('bad.yml', 'ssd_root: [unclosed\n')
    assert.throws(
      () => loadConfig({ path, home: box.home, env: {} }),
      (error: unknown) => error instanceof BardolierError && error.code === 'CONFIG_INVALID',
    )
  })

  test('the config file lives on the internal disk, not the SSD', () => {
    const path = defaultConfigPath({}, '/Users/someone')
    assert.equal(path, '/Users/someone/.config/bardolier/config.yml')
  })
})

describe('service catalogue resolution (cli-spec.md §4.1)', () => {
  test('falls back to the bundled default when the SSD has none', () => {
    const box = sandbox()
    const { config } = loadConfig({ path: box.configPath, home: box.home, env: { BDLR_SSD_ROOT: box.root } })
    const resolved = resolveCatalogue(config)
    assert.equal(resolved.origin, 'bundled')
    assert.deepEqual(Object.keys(resolved.catalogue.services).sort(), ['mongo', 'postgres', 'redis'])
  })

  test('prefers $SSD_ROOT/services.yml over the bundled default', () => {
    const box = sandbox()
    box.writeFile(
      join('ssd', 'claude-projects', 'services.yml'),
      'services:\n  minio:\n    display: MinIO\n    image: minio/minio\n    container_port: 9000\n    host_port_base: 9000\n    volume: "{project}_minio"\n    mount: /data\n',
    )
    const { config } = loadConfig({ path: box.configPath, home: box.home, env: { BDLR_SSD_ROOT: box.root } })
    const resolved = resolveCatalogue(config)
    assert.equal(resolved.origin, 'ssd')
    assert.deepEqual(Object.keys(resolved.catalogue.services), ['minio'])
  })

  test('a configured catalogue_path that does not exist is an error, not a silent fallback', () => {
    const box = sandbox()
    box.writeConfig({ catalogue_path: join(box.home, 'missing.yml') })
    const { config } = loadConfig({ path: box.configPath, home: box.home, env: { BDLR_SSD_ROOT: box.root } })
    assert.throws(
      () => resolveCatalogue(config),
      (error: unknown) => error instanceof BardolierError && error.code === 'CONFIG_INVALID',
    )
  })

  test('a catalogue that breaks the schema is CONFIG_INVALID', () => {
    const box = sandbox()
    box.writeFile(join('ssd', 'claude-projects', 'services.yml'), 'services:\n  redis:\n    display: Redis\n')
    const { config } = loadConfig({ path: box.configPath, home: box.home, env: { BDLR_SSD_ROOT: box.root } })
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

describe('project discovery (cli-spec.md §3)', () => {
  test('an absent SSD reports unmounted instead of throwing', () => {
    const box = sandbox()
    const { config } = loadConfig({
      path: box.configPath,
      home: box.home,
      env: { BDLR_SSD_ROOT: join(box.root, 'not-here') },
    })
    const discovery = discoverProjects(config)
    assert.equal(discovery.mounted, false)
    assert.deepEqual([...discovery.projects], [])
    assert.equal(probeSsd(config).mounted, false)
  })

  test('an empty SSD yields no projects and no problems', () => {
    const box = sandbox()
    const ctx = makeContext(box)
    const discovery = discoverProjects(ctx.config)
    assert.equal(discovery.mounted, true)
    assert.equal(discovery.projects.length, 0)
    assert.equal(discovery.invalid.length, 0)
  })

  test('finds manifests, sorted by name for deterministic output', () => {
    const box = sandbox()
    box.writeProject('zeta', manifest('zeta'))
    box.writeProject('alpha', manifest('alpha', { archetype: 'library' }))
    const discovery = discoverProjects(makeContext(box).config)
    assert.deepEqual(discovery.projects.map((p) => p.name), ['alpha', 'zeta'])
  })

  test('ignores hidden dirs, files, and dirs without a manifest', () => {
    const box = sandbox()
    box.writeProject('real', manifest('real'))
    box.writeFile(join('ssd', 'claude-projects', 'notes.txt'), 'hello')
    box.writeFile(join('ssd', 'claude-projects', '.Trashes', 'x'), 'x')
    box.writeFile(join('ssd', 'claude-projects', 'scratch', 'README.md'), '#')
    const discovery = discoverProjects(makeContext(box).config)
    assert.deepEqual(discovery.projects.map((p) => p.name), ['real'])
    assert.equal(discovery.invalid.length, 0)
  })

  test('reports an invalid manifest instead of dropping or guessing at it', () => {
    const box = sandbox()
    box.writeProject('good', manifest('good'))
    box.writeProject('bad', { ...manifest('bad'), archetype: 'nonsense' })
    const discovery = discoverProjects(makeContext(box).config)
    assert.deepEqual(discovery.projects.map((p) => p.name), ['good'])
    assert.deepEqual(discovery.invalid.map((p) => p.name), ['bad'])
  })

  test('a manifest whose name disagrees with its directory is invalid', () => {
    const box = sandbox()
    box.writeProject('ondisk', manifest('inyaml'))
    const discovery = discoverProjects(makeContext(box).config)
    assert.equal(discovery.projects.length, 0)
    assert.match(discovery.invalid[0]?.reason ?? '', /directory/)
  })
})

describe('docker probe', () => {
  const psLine = (name: string, labels = '') =>
    `${JSON.stringify({ Names: name, Image: 'alpine', State: 'running', Labels: labels })}\n`

  test('parses `docker ps` json lines, names and labels', async () => {
    const runner: DockerRunner = async (args) => {
      if (args[0] === 'ps') {
        return { code: 0, stdout: psLine('bardolier-a', 'com.docker.compose.project=bardolier-a'), stderr: '' }
      }
      return { code: 0, stdout: '', stderr: '' }
    }
    const containers = await createDocker(runner).runningContainers()
    assert.deepEqual([...(containers[0]?.names ?? [])], ['bardolier-a'])
    assert.equal(containers[0]?.labels['com.docker.compose.project'], 'bardolier-a')
  })

  test('reports unavailable rather than throwing when the daemon is down', async () => {
    const runner: DockerRunner = async () => ({ code: 1, stdout: '', stderr: 'Cannot connect to the Docker daemon' })
    assert.equal(await createDocker(runner).available(), false)
  })

  test('maps a failed query to DOCKER_UNAVAILABLE, never raw stderr', async () => {
    const runner: DockerRunner = async () => ({ code: 125, stdout: '', stderr: 'boom' })
    await assert.rejects(
      () => createDocker(runner).runningContainers(),
      (error: unknown) => error instanceof BardolierError && error.code === 'DOCKER_UNAVAILABLE',
    )
  })

  test('snapshots per invocation — one question, one subprocess', async () => {
    let calls = 0
    const runner: DockerRunner = async () => {
      calls += 1
      return { code: 0, stdout: psLine('bardolier-a'), stderr: '' }
    }
    const docker = createDocker(runner)
    await docker.runningContainers()
    await docker.runningContainers()
    assert.equal(calls, 1)
  })

  test('survives an unparseable line without losing the rest', async () => {
    const runner: DockerRunner = async () => ({ code: 0, stdout: `not json\n${psLine('bardolier-b')}`, stderr: '' })
    const containers = await createDocker(runner).runningContainers()
    assert.equal(containers.length, 1)
  })
})

describe('status (cli-spec.md §7)', () => {
  test('empty SSD: valid §7 JSON with empty arrays', async () => {
    const box = sandbox()
    const status = await collectStatus(makeContext(box))
    assert.deepEqual(status.projects, [])
    assert.deepEqual(status.orphaned_volumes, [])
    assert.equal(status.ssd.mounted, true)
    assert.ok(validate('status', status).valid)
  })

  test('succeeds with the SSD unmounted — reporting is not failing', async () => {
    const box = sandbox()
    const ctx = makeContext(box, stubDocker(), { env: { BDLR_SSD_ROOT: join(box.root, 'unplugged') } })
    const status = await collectStatus(ctx)
    assert.equal(status.ssd.mounted, false)
    assert.equal(status.ssd.root, join(box.root, 'unplugged'))
    assert.deepEqual(status.projects, [])
    assert.ok(validate('status', status).valid)
  })

  test('succeeds with Docker down, reporting everything stopped', async () => {
    const box = sandbox()
    box.writeProject('myapp', manifest('myapp', { services: { postgres: { host_port: 5433 } } }))
    const status = await collectStatus(makeContext(box, stubDocker({ available: false })))
    assert.equal(status.docker.available, false)
    assert.equal(status.projects[0]?.state, 'stopped')
    assert.equal(status.projects[0]?.dev_container, null)
    assert.equal(status.projects[0]?.services[0]?.state, 'stopped')
    assert.ok(validate('status', status).valid)
  })

  test('resolves services from the catalogue, host port from the manifest', async () => {
    const box = sandbox()
    box.writeProject('myapp', manifest('myapp', { services: { postgres: { host_port: 5433 } } }))
    const status = await collectStatus(makeContext(box))
    assert.deepEqual(status.projects[0]?.services[0], {
      key: 'postgres',
      display: 'PostgreSQL',
      state: 'stopped',
      host_port: 5433,
      container_port: 5432,
      connection_hint: 'postgresql://localhost:5433',
    })
  })

  test('all containers up = running; dev_container named', async () => {
    const box = sandbox()
    box.writeProject('myapp', manifest('myapp', { services: { postgres: { host_port: 5433 } } }))
    const docker = stubDocker({ running: [devContainerName('myapp'), serviceContainerName('myapp', 'postgres')] })
    const status = await collectStatus(makeContext(box, docker))
    assert.equal(status.projects[0]?.state, 'running')
    assert.equal(status.projects[0]?.dev_container, 'bardolier-myapp')
    assert.equal(status.projects[0]?.services[0]?.state, 'running')
  })

  test('some containers up = partial', async () => {
    const box = sandbox()
    box.writeProject('myapp', manifest('myapp', { services: { postgres: { host_port: 5433 } } }))
    const status = await collectStatus(makeContext(box, stubDocker({ running: [devContainerName('myapp')] })))
    assert.equal(status.projects[0]?.state, 'partial')
    assert.equal(status.projects[0]?.services[0]?.state, 'stopped')
  })

  test('a service up with the dev container down is still partial', async () => {
    const box = sandbox()
    box.writeProject('myapp', manifest('myapp', { services: { postgres: { host_port: 5433 } } }))
    const docker = stubDocker({ running: [serviceContainerName('myapp', 'postgres')] })
    const status = await collectStatus(makeContext(box, docker))
    assert.equal(status.projects[0]?.state, 'partial')
    assert.equal(status.projects[0]?.dev_container, null)
  })

  test('services are ordered by key, projects by name', async () => {
    const box = sandbox()
    box.writeProject('b', manifest('b'))
    box.writeProject('a', manifest('a', { services: { redis: { host_port: 6379 }, mongo: { host_port: 27017 } } }))
    const status = await collectStatus(makeContext(box))
    assert.deepEqual(status.projects.map((p) => p.name), ['a', 'b'])
    assert.deepEqual(status.projects[0]?.services.map((s) => s.key), ['mongo', 'redis'])
  })

  test('a service key the catalogue no longer defines is omitted, not invented', async () => {
    const box = sandbox()
    box.writeProject('myapp', manifest('myapp', { services: { ghost: { host_port: 9999 } } }))
    const status = await collectStatus(makeContext(box, stubDocker({ running: [devContainerName('myapp')] })))
    assert.deepEqual(status.projects[0]?.services, [])
    // Still counted for state: the attachment exists even if undescribable.
    assert.equal(status.projects[0]?.state, 'partial')
    assert.ok(validate('status', status).valid)
  })

  test('named project filters to one, keeping the §7 envelope', async () => {
    const box = sandbox()
    box.writeProject('one', manifest('one'))
    box.writeProject('two', manifest('two'))
    const status = await collectStatus(makeContext(box), 'two')
    assert.deepEqual(status.projects.map((p) => p.name), ['two'])
    assert.ok(validate('status', status).valid)
  })

  test('an unknown name is PROJECT_NOT_FOUND (§6)', async () => {
    const box = sandbox()
    await assert.rejects(
      () => collectStatus(makeContext(box), 'ghost'),
      (error: unknown) => error instanceof BardolierError && error.code === 'PROJECT_NOT_FOUND',
    )
  })

  test('a named project with a broken manifest says so, rather than "not found"', async () => {
    const box = sandbox()
    box.writeProject('bad', { ...manifest('bad'), archetype: 'nonsense' })
    await assert.rejects(
      () => collectStatus(makeContext(box), 'bad'),
      (error: unknown) => error instanceof BardolierError && error.code === 'CONFIG_INVALID',
    )
  })

  test('is read-only: nothing is created under the SSD root', async () => {
    const box = sandbox()
    box.writeProject('myapp', manifest('myapp', { services: { postgres: { host_port: 5433 } } }))
    const before = readdirSync(box.root).sort()
    await collectStatus(makeContext(box))
    assert.deepEqual(readdirSync(box.root).sort(), before)
    assert.equal(existsSync(join(box.root, 'myapp', 'docker-compose.yml')), false)
  })
})

describe('list (cli-spec.md §6)', () => {
  test('returns name, archetype and state, and validates', async () => {
    const box = sandbox()
    box.writeProject('myapp', manifest('myapp'))
    const output = await collectList(makeContext(box, stubDocker({ running: [devContainerName('myapp')] })))
    assert.deepEqual(output.projects, [{ name: 'myapp', archetype: 'web', state: 'running' }])
    assert.ok(validate('list', output).valid)
  })

  test('empty SSD lists nothing, cleanly', async () => {
    const box = sandbox()
    const output = await collectList(makeContext(box))
    assert.deepEqual(output.projects, [])
    assert.ok(validate('list', output).valid)
  })

  test('raises SSD_NOT_MOUNTED where status deliberately does not', async () => {
    const box = sandbox()
    const ctx = makeContext(box, stubDocker(), { env: { BDLR_SSD_ROOT: join(box.root, 'unplugged') } })
    await assert.rejects(
      () => collectList(ctx),
      (error: unknown) => error instanceof BardolierError && error.code === 'SSD_NOT_MOUNTED',
    )
    // ...and the same context still answers status.
    assert.equal((await collectStatus(ctx)).ssd.mounted, false)
  })
})

describe('doctor (cli-spec.md §6)', () => {
  test('emits every declared check, in a schema-valid report', async () => {
    const box = sandbox()
    const report = await collectDoctor(makeContext(box))
    assert.deepEqual(report.findings.map((f) => f.id).sort(), [...DOCTOR_CHECKS].sort())
    assert.ok(validate('doctor', report).valid)
  })

  test('a healthy environment is all-ok', async () => {
    const box = sandbox()
    box.writeProject('myapp', manifest('myapp', { services: { postgres: { host_port: 5433 } } }))
    const docker = stubDocker({ images: ['bardolier-web', 'bardolier-ios', 'bardolier-and'] })
    const report = await collectDoctor(makeContext(box, docker))
    assert.equal(report.ok, true, JSON.stringify(report.findings.filter((f) => !f.ok), null, 2))
  })

  test('reports the SSD absent, with a remedy', async () => {
    const box = sandbox()
    const ctx = makeContext(box, stubDocker(), { env: { BDLR_SSD_ROOT: join(box.root, 'unplugged') } })
    const report = await collectDoctor(ctx)
    const ssd = finding(report, 'ssd')
    assert.equal(ssd.ok, false)
    assert.ok(ssd.remedy)
    assert.equal(report.ok, false)
  })

  test('reports the SSD present once the root is readable', async () => {
    const box = sandbox()
    const report = await collectDoctor(makeContext(box))
    assert.equal(finding(report, 'ssd').ok, true)
  })

  test('Docker down: says so, and admits base images could not be checked', async () => {
    const box = sandbox()
    const report = await collectDoctor(makeContext(box, stubDocker({ available: false })))
    assert.equal(finding(report, 'docker').ok, false)
    const images = finding(report, 'base_images')
    assert.equal(images.ok, false)
    assert.match(images.detail, /Could not check/)
  })

  test('names the missing base images', async () => {
    const box = sandbox()
    const report = await collectDoctor(makeContext(box, stubDocker({ images: ['bardolier-web'] })))
    const images = finding(report, 'base_images')
    assert.equal(images.ok, false)
    assert.match(images.detail, /bardolier-ios/)
    assert.doesNotMatch(images.detail, /bardolier-web/)
  })

  test('a broken catalogue is a finding, not a crash', async () => {
    const box = sandbox()
    box.writeFile(join('ssd', 'claude-projects', 'services.yml'), 'services: {}\n')
    const report = await collectDoctor(makeContext(box))
    assert.equal(finding(report, 'catalogue').ok, false)
    // The other checks still ran.
    assert.equal(finding(report, 'ssd').ok, true)
  })

  test('flags an invalid manifest and an unknown service key', async () => {
    const box = sandbox()
    box.writeProject('bad', { ...manifest('bad'), archetype: 'nonsense' })
    box.writeProject('myapp', manifest('myapp', { services: { ghost: { host_port: 9999 } } }))
    const manifests = finding(await collectDoctor(makeContext(box)), 'manifests')
    assert.equal(manifests.ok, false)
    assert.match(manifests.detail, /bad:/)
    assert.match(manifests.detail, /ghost/)
  })

  test('missing config file is not a fault', async () => {
    const box = sandbox()
    const report = await collectDoctor(makeContext(box))
    const config = finding(report, 'config')
    assert.equal(config.ok, true)
    assert.match(config.detail, /using defaults/)
  })
})
