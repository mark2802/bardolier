/**
 * Phase 19 — the project layout: work, data, local, home.
 *
 * A project directory stops being a repository with bardolier's files scattered
 * through it and becomes four bind-mounted folders around them, with the
 * service data among them rather than in a named volume on the internal disk.
 * Four properties:
 *   - THE BIND SOURCES EXIST BEFORE COMPOSE RUNS, at `new` and again at every
 *     `up`. One Docker creates itself comes back root-owned — or, on Docker
 *     Desktop, inside the VM, which is data that never reaches the disk.
 *   - NOTHING BARDOLIER WRITES IS IN A WORKING TREE, so there is nothing to
 *     ignore and `git clean -xdf` cannot reach `data/`.
 *   - AN ORPHANED DATA DIRECTORY IS THE PROJECT'S OWN: derived from `ls data/`
 *     minus the manifest's keys, needing only the one root that holds it.
 *   - THE DATA IS INSIDE THE DIRECTORY, so `delete` cannot keep it — it refuses
 *     PROJECT_HAS_DATA rather than destroying it quietly.
 */

import { test, describe, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { parse as parseYaml } from 'yaml'

import { BardolierError } from '../cli/src/errors.ts'
import { validate } from '../cli/src/schema.ts'
import { renderCompose } from '../cli/src/compose.ts'
import { CONTAINER_HOME } from '../cli/src/images.ts'
import {
  DATA_DIR,
  NEVER_INDEX,
  PROJECT_DIRS,
  dataDir,
  directorySize,
  ensureProjectDirs,
  holdsData,
  homeDir,
  serviceDataDir,
  workDir,
} from '../cli/src/layout.ts'
import { seededFiles } from '../cli/src/scaffold.ts'
import { runNew } from '../cli/src/commands/new.ts'
import { runUp } from '../cli/src/commands/up.ts'
import { runDelete } from '../cli/src/commands/delete.ts'
import { runServiceRemove } from '../cli/src/commands/service.ts'
import { collectStatus } from '../cli/src/commands/status.ts'
import { collectOrphanedVolumes, runVolumeRemove } from '../cli/src/commands/volumes.ts'
import { makeContext, makeSandbox, manifest, stubDocker, type Sandbox } from './helpers.ts'

const sandboxes: Sandbox[] = []
function sandbox(): Sandbox {
  const box = makeSandbox()
  sandboxes.push(box)
  return box
}
afterEach(() => {
  while (sandboxes.length > 0) sandboxes.pop()?.cleanup()
})

// ── the four directories (§3, §4.2) ──────────────────────────────────────────

describe('the project directory’s shape', () => {
  test('`new` creates the four folders and the one seed, and nothing else', async () => {
    const box = sandbox()
    const result = await runNew(makeContext(box), { name: 'myapp', archetype: 'web', services: undefined })

    assert.deepEqual(result.seeded, ['work/CLAUDE.md'])
    assert.deepEqual(
      readdirSync(box.path('myapp')).sort(),
      ['data', 'docker-compose.yml', 'home', 'local', 'project.yml', 'work'],
    )
    assert.deepEqual(readdirSync(box.path('myapp', 'work')), ['CLAUDE.md'])
    assert.deepEqual(readdirSync(box.path('myapp', 'home')), [])
    assert.deepEqual(readdirSync(box.path('myapp', 'local')), [])
  })

  test('no ignore file is written anywhere — there is no repo root to seed (§10)', async () => {
    const box = sandbox()
    await runNew(makeContext(box), { name: 'myapp', archetype: 'web', services: undefined })
    for (const where of [[], ['work'], ['data'], ['local'], ['home']]) {
      for (const file of ['.gitignore', '.dockerignore']) {
        assert.equal(box.exists('myapp', ...where, file), false, `${[...where, file].join('/')} was written`)
      }
    }
    for (const archetype of ['web', 'ios', 'android', 'library'] as const) {
      assert.deepEqual(seededFiles('myapp', archetype).map((f) => f.name), ['work/CLAUDE.md'])
    }
  })

  test('`data/` carries the Spotlight marker, so `mds` never comes for the database', async () => {
    const box = sandbox()
    await runNew(makeContext(box), { name: 'myapp', archetype: 'web', services: undefined })
    assert.ok(box.exists('myapp', DATA_DIR, NEVER_INDEX))
  })

  test('a service attached at `new` gets its data directory before compose ever runs', async () => {
    const box = sandbox()
    await runNew(makeContext(box), { name: 'myapp', archetype: 'web', services: 'postgres,redis' })
    assert.ok(existsSync(serviceDataDir(box.path('myapp'), 'postgres')))
    assert.ok(existsSync(serviceDataDir(box.path('myapp'), 'redis')))
  })

  test('`up` re-ensures every bind source, so a hand-deleted folder heals', async () => {
    const box = sandbox()
    const ctx = makeContext(box, stubDocker())
    await runNew(ctx, { name: 'myapp', archetype: 'web', services: 'postgres' })

    // The failure this prevents: Docker creates a missing bind source itself,
    // as root, and the container's own uid cannot write its own $HOME.
    for (const name of PROJECT_DIRS) rmSync(box.path('myapp', name), { recursive: true, force: true })
    rmSync(serviceDataDir(box.path('myapp'), 'postgres'), { recursive: true, force: true })

    await runUp(ctx, { name: 'myapp', noShell: true })

    for (const name of PROJECT_DIRS) assert.ok(box.exists('myapp', name), `${name}/ was not recreated`)
    assert.ok(existsSync(serviceDataDir(box.path('myapp'), 'postgres')))
  })

  test('ensureProjectDirs is idempotent and never rewrites the marker', () => {
    const box = sandbox()
    const dir = box.path('bare')
    mkdirSync(dir, { recursive: true })
    ensureProjectDirs(dir)
    writeFileSync(join(dataDir(dir), NEVER_INDEX), 'edited by someone')
    ensureProjectDirs(dir, ['postgres'])
    assert.equal(box.read('bare', DATA_DIR, NEVER_INDEX), 'edited by someone')
  })
})

// ── compose (§9) ─────────────────────────────────────────────────────────────

describe('what the generated file binds', () => {
  test('four relative binds, /data read-only, and no named volume but the cache', () => {
    const doc = parseYaml(renderCompose({ manifest: manifest('myapp'), catalogue: null })) as Record<string, any>

    assert.deepEqual(doc.services.dev.volumes, [
      './work:/work',
      './data:/data:ro',
      './local:/local',
      `./home:${CONTAINER_HOME}`,
      'bardolier-uv-cache:/cache/uv',
    ])
    assert.deepEqual(Object.keys(doc.volumes), ['bardolier-uv-cache'])
    assert.equal(doc.volumes['bardolier-uv-cache'].external, true)
  })

  test('every bind is relative, so the project folder stays relocatable', () => {
    const rendered = renderCompose({ manifest: manifest('myapp'), catalogue: null })
    for (const line of rendered.split('\n').filter((l) => l.trim().startsWith('- ./'))) {
      assert.ok(!line.includes('/Volumes') && !line.includes('/tmp'), line)
    }
  })
})

// ── nothing is inside a working tree (§3) ────────────────────────────────────

describe('the repository boundary', () => {
  test('the seed lives in work/, where a clone beside it will never contain it', async () => {
    const box = sandbox()
    await runNew(makeContext(box), { name: 'myapp', archetype: 'web', services: undefined })
    assert.ok(box.exists('myapp', 'work', 'CLAUDE.md'))
    assert.equal(box.exists('myapp', 'CLAUDE.md'), false)
  })

  test('everything bardolier writes is above work/, so a working tree holds none of it', async () => {
    const box = sandbox()
    const ctx = makeContext(box, stubDocker())
    await runNew(ctx, { name: 'myapp', archetype: 'web', services: 'postgres' })
    await runUp(ctx, { name: 'myapp', noShell: true })

    // What `git status` in `work/` could ever see: its own contents.
    assert.deepEqual(readdirSync(box.path('myapp', 'work')), ['CLAUDE.md'])
    // …and what `git clean -xdf` in there therefore cannot reach.
    for (const name of ['project.yml', 'docker-compose.yml', DATA_DIR, 'home', 'local']) {
      assert.ok(box.exists('myapp', name), `${name} must live above work/`)
    }
  })

  test('status reports work_dir, so the app never composes the path', async () => {
    const box = sandbox()
    const ctx = makeContext(box, stubDocker())
    await runNew(ctx, { name: 'myapp', archetype: 'web', services: undefined })

    const status = await collectStatus(ctx, 'myapp')
    assert.equal(status.projects[0]?.work_dir, workDir(box.path('myapp')))
    assert.ok(validate('status', status).valid)
  })
})

// ── orphaned data directories (§6, §7) ───────────────────────────────────────

describe('a detached service’s data directory', () => {
  async function detached(box: Sandbox) {
    const ctx = makeContext(box, stubDocker())
    await runNew(ctx, { name: 'alpha', archetype: 'web', services: 'postgres' })
    writeFileSync(join(serviceDataDir(box.path('alpha'), 'postgres'), 'PG_VERSION'), '17\n')
    await runServiceRemove(ctx, { project: 'alpha', service: 'postgres' })
    return ctx
  }

  test('is kept, and reported as a directory orphan with its path and size', async () => {
    const box = sandbox()
    const ctx = await detached(box)

    const output = await collectOrphanedVolumes(ctx)
    assert.deepEqual(output.orphaned, [
      {
        name: 'alpha/postgres',
        kind: 'directory',
        path: serviceDataDir(box.path('alpha'), 'postgres'),
        size_bytes: 3,
        size_human: '3 B',
        last_project: 'alpha',
      },
    ])
    assert.ok(validate('volumes-orphaned', output).valid)
  })

  test('needs only its own root — another root being unreadable is not its business', async () => {
    // The claim is `ls data/` against the manifest beside it. No labels, no
    // Docker, no second root consulted: the directory's own project answers.
    const box = sandbox()
    const ctx = await detached(box)
    const scan = await collectOrphanedVolumes(ctx)
    assert.equal(scan.orphaned[0]?.last_project, 'alpha')
  })

  test('`volumes rm` takes it, by name or by path', async () => {
    const box = sandbox()
    const ctx = await detached(box)
    const path = serviceDataDir(box.path('alpha'), 'postgres')

    const removed = await runVolumeRemove(ctx, { name: path, force: true, json: true })
    assert.equal(removed.removed, true)
    assert.equal(removed.kind, 'directory')
    assert.equal(existsSync(path), false)
  })

  test('a loose file under data/ is not a service, and neither is the marker', async () => {
    const box = sandbox()
    const ctx = makeContext(box, stubDocker())
    await runNew(ctx, { name: 'alpha', archetype: 'web', services: undefined })
    writeFileSync(join(dataDir(box.path('alpha')), 'notes.txt'), 'scratch\n')

    assert.deepEqual((await collectOrphanedVolumes(ctx)).orphaned, [])
  })
})

// ── delete (§6, PROJECT_HAS_DATA) ────────────────────────────────────────────

describe('deleting a project that holds data', () => {
  async function withData(box: Sandbox) {
    const ctx = makeContext(box, stubDocker())
    await runNew(ctx, { name: 'alpha', archetype: 'web', services: 'postgres' })
    writeFileSync(join(serviceDataDir(box.path('alpha'), 'postgres'), 'PG_VERSION'), '17\n')
    return ctx
  }

  test('refuses PROJECT_HAS_DATA and names what it would destroy', async () => {
    const box = sandbox()
    const ctx = await withData(box)

    await assert.rejects(
      () => runDelete(ctx, { name: 'alpha', force: true, purge: false, json: true }),
      (error: unknown) => {
        assert.ok(error instanceof BardolierError)
        assert.equal(error.code, 'PROJECT_HAS_DATA')
        assert.ok(error.message.includes(dataDir(box.path('alpha'))))
        assert.ok(error.message.includes(homeDir(box.path('alpha'))))
        assert.equal(error.details?.bytes, 3)
        return true
      },
    )
    assert.ok(box.exists('alpha', 'project.yml'))
  })

  test('`home/` alone is enough — the login and the shell history are data too', async () => {
    const box = sandbox()
    const ctx = makeContext(box, stubDocker())
    await runNew(ctx, { name: 'alpha', archetype: 'web', services: undefined })
    mkdirSync(join(homeDir(box.path('alpha')), '.claude'), { recursive: true })
    writeFileSync(join(homeDir(box.path('alpha')), '.claude', 'credentials'), 'token\n')

    await assert.rejects(
      () => runDelete(ctx, { name: 'alpha', force: true, purge: false, json: true }),
      (error: unknown) => error instanceof BardolierError && error.code === 'PROJECT_HAS_DATA',
    )
  })

  test('an untouched project deletes without --purge — empty scaffolding is not data', async () => {
    const box = sandbox()
    const ctx = makeContext(box, stubDocker())
    await runNew(ctx, { name: 'alpha', archetype: 'web', services: 'postgres' })

    const result = await runDelete(ctx, { name: 'alpha', force: true, purge: false, json: true })
    assert.equal(result.deleted, true)
    assert.equal(box.exists('alpha'), false)
  })

  test('--purge takes the whole folder, data and home with it', async () => {
    const box = sandbox()
    const ctx = await withData(box)

    const result = await runDelete(ctx, { name: 'alpha', force: true, purge: true, json: true })
    assert.equal(result.deleted, true)
    assert.equal(box.exists('alpha'), false)
    // A project owns no named volume any more, so there is nothing to report.
    assert.deepEqual(result.removed_volumes, [])
    assert.deepEqual(result.kept_volumes, [])
  })
})

// ── the measuring helpers ────────────────────────────────────────────────────

describe('layout.ts’s two questions about a directory', () => {
  test('directorySize walks the tree and counts files only', () => {
    const box = sandbox()
    const dir = box.path('sized')
    mkdirSync(join(dir, 'a', 'b'), { recursive: true })
    writeFileSync(join(dir, 'top'), 'x'.repeat(10))
    writeFileSync(join(dir, 'a', 'b', 'deep'), 'y'.repeat(5))
    assert.equal(directorySize(dir), 15)
    assert.equal(directorySize(join(dir, 'nope')), 0, 'an absent directory is zero, not a throw')
  })

  test('holdsData ignores the scaffolding it did not put there', () => {
    const box = sandbox()
    const dir = box.path('empty')
    mkdirSync(dir, { recursive: true })
    ensureProjectDirs(dir, ['postgres'])
    assert.equal(holdsData(dir), false, 'empty bind sources and the marker are ours, not the user’s')

    writeFileSync(join(serviceDataDir(dir, 'postgres'), 'PG_VERSION'), '17\n')
    assert.equal(holdsData(dir), true)
  })
})
