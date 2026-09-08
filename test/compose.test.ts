/**
 * Compose generation: determinism, the binds, $HOME, the passed-through environment, app_port.
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { parse as parseYaml } from 'yaml'

import { BardolierError } from '../cli/src/errors.ts'
import { validate } from '../cli/src/schema.ts'
import { COMPOSE_FILENAME, PASSTHROUGH_ENV, renderCompose } from '../cli/src/compose.ts'
import { composeProject, devContainerName, serviceContainerName } from '../cli/src/naming.ts'
import { orderManifest, regenerateCompose, renderManifest } from '../cli/src/workspace.ts'
import { runNew } from '../cli/src/commands/new.ts'
import { runUp } from '../cli/src/commands/up.ts'
import { collectStatus } from '../cli/src/commands/status.ts'
import type { ProjectManifest } from '../cli/src/model/project.ts'
import { CONTAINER_HOME } from '../cli/src/images.ts'
import { ARCHETYPE_APP_PORT } from '../cli/src/model/archetype.ts'
import { HOME_DIR } from '../cli/src/layout.ts'
import { assignedPorts } from '../cli/src/allocator.ts'
import type { Git, GitFacts } from '../cli/src/git.ts'
import { createContext } from '../cli/src/context.ts'
import {
  catalogue,
  manifest,
  ports,
  project,
  type Sandbox,
  sandboxes,
  stubDocker,
} from './helpers.ts'

const sandbox = sandboxes()

/** A manifest with services already attached — Phase 3 assigns these for real. */
function withServices(name = 'myapp'): ProjectManifest {
  return manifest(name, { services: { redis: { host_port: 6380 }, postgres: { host_port: 5433 } } })
}

/**
 * Git facts a test can dictate, or a repo that is not one.
 *
 * `name`/`email` are `string | null` because that is what `GitIdentity`
 * promises: `createGit` normalises an unset OR EMPTY `git config` value to null
 * — which is not hypothetical, an empty `user.email =` line in a real
 * `~/.gitconfig` is exactly how a Mac ends up with a name and no address.
 */
function stubGit(facts: GitFacts | null, name: string | null = 'Mark', email: string | null = 'mark@example.com'): Git {
  return {
    identity: async () => ({ name, email }),
    facts: async () => facts,
  }
}

function context(box: Sandbox, options: Parameters<typeof createContext>[0] = {}) {
  return createContext({
    env: { BARDOLIER_ROOT: box.root },
    home: box.home,
    path: box.configPath,
    ports: { isFree: async () => true },
    ...options,
  })
}

// ── Compose generation (§9) ───────────────────────────────────────────────────
describe('compose generation (cli-spec.md §9)', () => {
  test('is deterministic: the same manifest renders the same bytes', () => {
    const source = withServices()
    const first = renderCompose({ manifest: source, catalogue: catalogue(sandbox()) })
    const second = renderCompose({ manifest: source, catalogue: catalogue(sandbox()) })
    assert.equal(first, second)
  })

  test('key order in the manifest cannot change the output', () => {
    // The same attachments, declared in the opposite order.
    const forwards = manifest('myapp', { services: { postgres: { host_port: 5433 }, redis: { host_port: 6380 } } })
    const backwards = manifest('myapp', { services: { redis: { host_port: 6380 }, postgres: { host_port: 5433 } } })
    assert.equal(
      renderCompose({ manifest: forwards, catalogue: catalogue(sandbox()) }),
      renderCompose({ manifest: backwards, catalogue: catalogue(sandbox()) }),
    )
  })

  test('regeneration on an unchanged manifest is a no-op write', () => {
    const box = sandbox()
    box.writeProject('myapp', manifest('myapp'))
    const dir = box.path('myapp')

    const first = regenerateCompose(dir, manifest('myapp'), null)
    assert.equal(first.changed, true, 'the first generation writes the file')
    const bytes = readFileSync(first.path, 'utf8')

    const second = regenerateCompose(dir, manifest('myapp'), null)
    assert.equal(second.changed, false, 'a second generation must find nothing to do')
    assert.equal(readFileSync(second.path, 'utf8'), bytes)
  })

  test('a hand-edited compose file is overwritten — project.yml is the truth', () => {
    const box = sandbox()
    box.writeProject('myapp', manifest('myapp'))
    const dir = box.path('myapp')
    regenerateCompose(dir, manifest('myapp'), null)
    writeFileSync(join(dir, COMPOSE_FILENAME), 'services: {evil: {image: nope}}\n')

    const again = regenerateCompose(dir, manifest('myapp'), null)
    assert.equal(again.changed, true)
    assert.ok(!readFileSync(again.path, 'utf8').includes('evil'))
  })

  test('the dev container binds the four project folders and publishes nothing', () => {
    const doc = parseYaml(renderCompose({ manifest: manifest('myapp'), catalogue: null })) as Record<string, any>
    const dev = doc.services.dev
    assert.equal(dev.container_name, devContainerName('myapp'))
    assert.equal(dev.image, 'bardolier-web:latest')
    // Four relative binds (§4.2), then the shared `uv` cache every
    // bardolier-web project mounts (Phase 11) — the one named volume left.
    // `/data` is read-only: writing into a live data directory from a second
    // container corrupts it.
    assert.deepEqual(dev.volumes, [
      './work:/work',
      './data:/data:ro',
      './local:/local',
      './home:/state/home',
      'bardolier-uv-cache:/cache/uv',
    ])
    assert.equal(dev.working_dir, '/work')
    assert.deepEqual(dev.command, ['sleep', 'infinity'])
    assert.equal(dev.ports, undefined, 'the dev container must not publish host ports')
  })

  test('the bind mount is relative, so where the SSD mounts cannot change the file', () => {
    const rendered = renderCompose({ manifest: manifest('myapp'), catalogue: null })
    assert.ok(!rendered.includes('/Volumes'))
    assert.ok(!rendered.includes('/tmp'))
  })

  test('a project on an image with no cache declares no named volume at all', () => {
    // bardolier-ios has no toolchain cache (images.ts); bardolier-web's `uv` cache
    // would otherwise be the one volume here, so this is the archetype that
    // isolates the claim: since phase 19 nothing a PROJECT owns is a volume.
    const ios = manifest('myapp', { archetype: 'ios', base_image: 'bardolier-ios' })
    const doc = parseYaml(renderCompose({ manifest: ios, catalogue: null })) as Record<string, any>
    assert.equal(doc.volumes, undefined)
    assert.deepEqual(Object.keys(doc.services), ['dev'])
  })

  test('attaching services adds no named volume either — the cache is the only one', () => {
    const doc = parseYaml(renderCompose({ manifest: withServices(), catalogue: catalogue(sandbox()) })) as Record<string, any>
    assert.deepEqual(Object.keys(doc.volumes), ['bardolier-uv-cache'])
    assert.equal(doc.volumes['bardolier-uv-cache'].external, true)
  })

  test('the dev container inherits the host names it is lent, and no values', () => {
    const doc = parseYaml(renderCompose({ manifest: manifest('myapp'), catalogue: null })) as Record<string, any>
    // Compose's LIST form: a bare name is passed through when the environment
    // running `compose up` has one and left UNSET otherwise. A `NAME=` here
    // would put an empty credential in the container instead of none.
    assert.deepEqual(doc.services.dev.environment, [...PASSTHROUGH_ENV])
    for (const entry of doc.services.dev.environment) {
      assert.ok(!entry.includes('='), `${entry} must not carry a value`)
    }
  })

  test('services publish host:container and bind their own data directory (§9)', () => {
    const doc = parseYaml(renderCompose({ manifest: withServices(), catalogue: catalogue(sandbox()) })) as Record<string, any>
    const postgres = doc.services.postgres
    assert.equal(postgres.container_name, serviceContainerName('myapp', 'postgres'))
    assert.equal(postgres.image, 'postgres:17')
    assert.deepEqual(postgres.ports, ['5433:5432'])
    // Named by the catalogue KEY, relative to the compose file, and read-write
    // here — the dev container sees the same bytes through a read-only /data.
    assert.deepEqual(postgres.volumes, ['./data/postgres:/var/lib/postgresql/data'])
  })

  test('{project} is interpolated in env, the one substitution left (§4.1)', () => {
    // The data directory is named by the catalogue KEY now, so the project
    // name appears nowhere in the bind — the path is already project-scoped.
    const doc = parseYaml(renderCompose({ manifest: withServices('shop'), catalogue: catalogue(sandbox()) })) as Record<string, any>
    assert.equal(doc.services.postgres.environment.POSTGRES_DB, 'shop')
    assert.deepEqual(doc.services.postgres.volumes, ['./data/postgres:/var/lib/postgresql/data'])
  })

  test('one network per project, namespaced by the compose project name', () => {
    const doc = parseYaml(renderCompose({ manifest: manifest('myapp'), catalogue: null })) as Record<string, any>
    assert.equal(doc.name, composeProject('myapp'))
  })

  test('a manifest naming an unknown service fails SERVICE_UNKNOWN, not silence', () => {
    const bad = manifest('myapp', { services: { kafka: { host_port: 9092 } } })
    assert.throws(
      () => renderCompose({ manifest: bad, catalogue: catalogue(sandbox()) }),
      (error: unknown) => error instanceof BardolierError && error.code === 'SERVICE_UNKNOWN',
    )
  })

  test('the generated file warns that it is generated', () => {
    assert.ok(renderCompose({ manifest: manifest('myapp'), catalogue: null }).includes('DO NOT EDIT'))
  })

  test('the manifest round-trips through its own writer without drift', () => {
    const source = withServices()
    const text = renderManifest(source)
    const reparsed = parseYaml(text) as ProjectManifest
    assert.ok(validate('project', reparsed).valid)
    assert.deepEqual(reparsed, parseYaml(renderManifest(reparsed)))
    // Sorted, whatever order the object was built in.
    assert.deepEqual(Object.keys((orderManifest(source).services ?? {}) as object), ['postgres', 'redis'])
  })
})

// ── $HOME survives the stop (§9) ─────────────────────────────────────────────
describe('the dev container home', () => {
  test('is bound from the project’s own home/ folder', () => {
    const doc = parseYaml(renderCompose({ manifest: manifest('myapp'), catalogue: null })) as Record<string, any>
    assert.ok(doc.services.dev.volumes.includes(`./${HOME_DIR}:${CONTAINER_HOME}`))
  })

  test('it is inside the project, so it needs no label to be attributed', () => {
    // Phase 19: the home moved from a labelled named volume into `home/`. The
    // project directory IS the attribution, and `delete` takes it with the dir.
    // (bardolier-web still declares the shared `uv` cache, which belongs to no
    // project — the point is that no volume is named after this one.)
    const doc = parseYaml(renderCompose({ manifest: manifest('myapp'), catalogue: null })) as Record<string, any>
    assert.deepEqual(Object.keys(doc.volumes ?? {}), ['bardolier-uv-cache'])
  })

  test('two projects never share one — each binds its own directory', async () => {
    const box = sandbox()
    const ctx = context(box, { docker: stubDocker() })
    await runNew(ctx, { name: 'alpha', archetype: 'web', services: undefined })
    await runNew(ctx, { name: 'beta', archetype: 'web', services: undefined })
    assert.ok(box.exists('alpha', HOME_DIR))
    assert.ok(box.exists('beta', HOME_DIR))
  })
})

// ── the host is lent, not copied (§9) ────────────────────────────────────────
describe('what the dev container inherits from the Mac', () => {
  test('the generated file names the variables and carries no values', () => {
    const rendered = renderCompose({ manifest: manifest('myapp'), catalogue: null })
    for (const name of PASSTHROUGH_ENV) {
      assert.match(rendered, new RegExp(`- ${name}$`, 'm'), `${name} must be passed through by name`)
      assert.ok(!rendered.includes(`${name}=`), `${name} must not be given a value in the file`)
    }
  })

  test('a credential is never written into the compose file', () => {
    // The determinism rule (§9) doing real work: the same manifest renders the
    // same bytes whether or not this Mac is holding a token.
    const rendered = renderCompose({ manifest: manifest('myapp'), catalogue: null })
    assert.ok(!rendered.includes('${'), 'no interpolation — an absent token must stay absent, not become empty')
  })

  test('up lends the host git identity so a commit in the container is attributable', async () => {
    const box = sandbox()
    const docker = stubDocker({ startsAs: [devContainerName('myapp')] })
    const ctx = context(box, { docker, git: stubGit(null, 'Ada', 'ada@example.com') })
    await runNew(ctx, { name: 'myapp', archetype: 'web', services: undefined })
    await runUp(ctx, { name: 'myapp', noShell: true })

    const up = docker.calls.find((call) => call.kind === 'up')
    assert.ok(up?.kind === 'up')
    assert.equal(up.target.env?.GIT_AUTHOR_NAME, 'Ada')
    assert.equal(up.target.env?.GIT_COMMITTER_EMAIL, 'ada@example.com')
  })

  test('a host with no git identity lends nothing rather than an empty name', async () => {
    const box = sandbox()
    const docker = stubDocker({ startsAs: [devContainerName('myapp')] })
    const ctx = context(box, { docker, git: stubGit(null, null, null) })
    await runNew(ctx, { name: 'myapp', archetype: 'web', services: undefined })
    await runUp(ctx, { name: 'myapp', noShell: true })

    const up = docker.calls.find((call) => call.kind === 'up')
    assert.ok(up?.kind === 'up')
    assert.equal(up.target.env?.GIT_AUTHOR_NAME, undefined, 'an empty identity is no identity')
  })
})

// ── the dev server (§9) ──────────────────────────────────────────────────────
describe('the dev-server port', () => {
  test('a web project is assigned one at creation and publishes it', async () => {
    const box = sandbox()
    const ctx = context(box)
    const created = await runNew(ctx, { name: 'site', archetype: 'web', services: undefined })
    assert.ok(validate('new', created).valid)

    const compose = box.read('site', 'docker-compose.yml') ?? ''
    const doc = parseYaml(compose) as Record<string, any>
    assert.deepEqual(doc.services.dev.ports, [`3000:${ARCHETYPE_APP_PORT.web}`])
    // Fixed inside, variable outside: the server's own config never changes.
    assert.ok(doc.services.dev.environment.includes(`PORT=${ARCHETYPE_APP_PORT.web}`))
  })

  test('an archetype that serves nothing publishes nothing', async () => {
    const box = sandbox()
    const ctx = context(box)
    await runNew(ctx, { name: 'app', archetype: 'ios', services: undefined })

    const doc = parseYaml(box.read('app', 'docker-compose.yml') ?? '') as Record<string, any>
    assert.equal(doc.services.dev.ports, undefined)
    assert.ok(!doc.services.dev.environment.some((entry: string) => entry.startsWith('PORT=')))
  })

  test('a second web project lands in the band rather than colliding', async () => {
    const box = sandbox()
    const ctx = context(box)
    await runNew(ctx, { name: 'one', archetype: 'web', services: undefined })
    await runNew(ctx, { name: 'two', archetype: 'web', services: undefined })

    const ports = assignedPorts(ctx)
    assert.equal([...ports.keys()].filter((port) => port >= 3000 && port < 3100).length, 2)
    assert.notEqual(
      parseYaml(box.read('one', 'project.yml') ?? '').app_port,
      parseYaml(box.read('two', 'project.yml') ?? '').app_port,
    )
  })

  test('a project that predates the field is assigned one on its next up', async () => {
    const box = sandbox()
    // Written without app_port — what every existing web project looks like.
    box.writeProject('legacy', manifest('legacy'))
    const docker = stubDocker({ startsAs: [devContainerName('legacy')] })
    const ctx = context(box, { docker })

    const result = await runUp(ctx, { name: 'legacy', noShell: true })

    assert.equal(result.app_port, 3000)
    assert.equal(result.app_url, 'http://localhost:3000')
    // Persisted, because §5 says a port is decided once and then kept.
    assert.equal(parseYaml(box.read('legacy', 'project.yml') ?? '').app_port, 3000)
  })

  test('status reports the URL rather than leaving the app to build one', async () => {
    const box = sandbox()
    const ctx = context(box)
    await runNew(ctx, { name: 'site', archetype: 'web', services: undefined })
    await runNew(ctx, { name: 'app', archetype: 'ios', services: undefined })

    const status = await collectStatus(ctx)
    assert.ok(validate('status', status).valid, 'status must still match its schema')
    const site = status.projects.find((p) => p.name === 'site')
    const app = status.projects.find((p) => p.name === 'app')
    assert.equal(site?.app_url, 'http://localhost:3000')
    assert.equal(app?.app_port, null, 'an ios project has no dev server')
    assert.equal(app?.app_url, null)
  })
})
