/**
 * `new`, `up`, `down`, `delete`, and the walks that run them end to end.
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml'

import { BardolierError } from '../cli/src/errors.ts'
import { validate } from '../cli/src/schema.ts'
import { COMPOSE_FILENAME, attachedKeys } from '../cli/src/compose.ts'
import { PROJECT_DIRS } from '../cli/src/layout.ts'
import { composeProject, devContainerName, serviceContainerName } from '../cli/src/naming.ts'
import { requireProject, writeManifest } from '../cli/src/workspace.ts'
import { seededFiles } from '../cli/src/scaffold.ts'
import { runNew } from '../cli/src/commands/new.ts'
import { runClone } from '../cli/src/commands/clone.ts'
import { runMove } from '../cli/src/commands/move.ts'
import { runUp } from '../cli/src/commands/up.ts'
import { runDown } from '../cli/src/commands/down.ts'
import { runDelete } from '../cli/src/commands/delete.ts'
import { collectStatus } from '../cli/src/commands/status.ts'
import { ARCHETYPES, ARCHETYPE_BASE_IMAGE } from '../cli/src/model/archetype.ts'
import type { Archetype } from '../cli/src/model/archetype.ts'
import type { ProjectManifest } from '../cli/src/model/project.ts'
import type { Sandbox } from './helpers.ts'
import { runServiceRemove } from '../cli/src/commands/service.ts'
import { runShell } from '../cli/src/commands/shell.ts'
import { collectOrphanedVolumes, runVolumeRemove } from '../cli/src/commands/volumes.ts'
import { runDownAll, runEject } from '../cli/src/commands/ssd.ts'
import { containingVolume, discoverProjects } from '../cli/src/projects.ts'
import { relocate, requireSpace, stageProject, stagingPath } from '../cli/src/transfer.ts'
import {
  FIXED_NOW,
  holder,
  makeContext,
  manifest,
  ports,
  project,
  readManifest,
  sandboxes,
  seedServiceData,
  stubConfirm,
  stubDevice,
  stubDocker,
  stubPorts,
  tempDirs,
  twoRoots,
} from './helpers.ts'

const sandbox = sandboxes()
const secondRoot = tempDirs('bardolier-root-b-')

/** A manifest with services already attached — Phase 3 assigns these for real. */
function withServices(name = 'myapp'): ProjectManifest {
  return manifest(name, { services: { redis: { host_port: 6380 }, postgres: { host_port: 5433 } } })
}

// ── new (§6, §10) ─────────────────────────────────────────────────────────────
describe('new (cli-spec.md §6, §10)', () => {
  test('creates the manifest, the seeds and the compose file, and validates', async () => {
    const box = sandbox()
    const ctx = makeContext(box)
    const result = await runNew(ctx, { name: 'myapp', archetype: 'web', services: undefined })

    assert.ok(validate('new', result).valid, 'new output must match new.schema.json')
    assert.deepEqual(result.seeded, ['work/CLAUDE.md'])
    assert.equal(result.project.base_image, 'bardolier-web')
    assert.equal(result.project.created, FIXED_NOW.toISOString())

    for (const file of ['project.yml', 'docker-compose.yml', 'work/CLAUDE.md']) {
      assert.ok(box.exists('myapp', file), `new did not write ${file}`)
    }
    // The four bind sources, and nothing scattered around them: no repo root
    // to seed means no `.gitignore` and no `.dockerignore` anywhere (§10).
    for (const name of PROJECT_DIRS) assert.ok(box.exists('myapp', name), `new did not create ${name}/`)
    for (const file of ['.gitignore', '.dockerignore', 'CLAUDE.md']) {
      assert.equal(box.exists('myapp', file), false, `new wrote ${file} at the project root`)
    }
    const written = parseYaml(box.read('myapp', 'project.yml') ?? '') as ProjectManifest
    assert.ok(validate('project', written).valid)
    assert.equal(written.name, 'myapp')
  })

  test('the new project is immediately visible to status', async () => {
    const box = sandbox()
    const ctx = makeContext(box)
    await runNew(ctx, { name: 'myapp', archetype: 'library', services: undefined })

    const status = await collectStatus(makeContext(box))
    assert.equal(status.projects.length, 1)
    assert.equal(status.projects[0]?.name, 'myapp')
    assert.equal(status.projects[0]?.state, 'stopped')
    assert.equal(status.projects[0]?.dev_container, null)
  })

  test('every archetype produces a manifest whose base_image matches §4.3', async () => {
    for (const archetype of ARCHETYPES) {
      const box = sandbox()
      const result = await runNew(makeContext(box), { name: 'p', archetype, services: undefined })
      assert.equal(result.project.base_image, ARCHETYPE_BASE_IMAGE[archetype])
    }
  })

  test('an existing directory is PROJECT_EXISTS, and is left untouched', async () => {
    const box = sandbox()
    box.writeProject('myapp', manifest('myapp'))
    writeFileSync(box.path('myapp', 'keepme'), 'precious')

    await assert.rejects(
      () => runNew(makeContext(box), { name: 'myapp', archetype: 'web', services: undefined }),
      (error: unknown) => error instanceof BardolierError && error.code === 'PROJECT_EXISTS',
    )
    assert.equal(box.read('myapp', 'keepme'), 'precious')
    assert.ok(!box.exists('myapp', 'CLAUDE.md'), 'a failed new must not seed anything')
  })

  test('an unreadable root is ROOT_UNREADABLE — never a project on the internal disk (phase 18)', async () => {
    const box = sandbox()
    const ctx = makeContext(box, stubDocker(), { env: { BARDOLIER_ROOT: join(box.root, 'unplugged') } })
    await assert.rejects(
      () => runNew(ctx, { name: 'myapp', archetype: 'web', services: undefined }),
      (error: unknown) => error instanceof BardolierError && error.code === 'ROOT_UNREADABLE',
    )
    assert.ok(!existsSync(join(box.root, 'unplugged')))
  })

  test('rejects a bad archetype and a bad name before touching the disk', async () => {
    const box = sandbox()
    for (const request of [
      { name: 'myapp', archetype: 'toaster', services: undefined },
      { name: 'My App', archetype: 'web', services: undefined },
      { name: '-leading', archetype: 'web', services: undefined },
      { name: '../escape', archetype: 'web', services: undefined },
      { name: undefined, archetype: 'web', services: undefined },
      { name: 'myapp', archetype: undefined, services: undefined },
    ]) {
      await assert.rejects(
        () => runNew(makeContext(box), request),
        (error: unknown) => error instanceof BardolierError && error.code === 'INVALID_ARGUMENT',
        `accepted ${JSON.stringify(request)}`,
      )
    }
  })

  test('a --services request that cannot be honoured creates nothing', async () => {
    // The successful path is test/services.test.ts's; what matters here is
    // that a rejected `new` leaves no half-made project behind.
    const box = sandbox()
    await assert.rejects(
      () => runNew(makeContext(box), { name: 'myapp', archetype: 'web', services: 'toaster' }),
      (error: unknown) => error instanceof BardolierError && error.code === 'SERVICE_UNKNOWN',
    )
    assert.ok(!box.exists('myapp'), 'nothing may be created when the request cannot be honoured')
  })

  test('seeded files are archetype-tuned and carry the boundary note (§10)', () => {
    const boundaries: Record<Archetype, string> = {
      web: 'in the container',
      library: 'in the container',
      ios: 'xcodebuild',
      android: 'emulator is host-side',
    }
    for (const archetype of ARCHETYPES) {
      const files = seededFiles('myapp', archetype)
      assert.deepEqual(files.map((f) => f.name), ['work/CLAUDE.md'], `${archetype} seeds more than the one file`)
      const claudeMd = files[0]?.contents ?? ''
      assert.ok(claudeMd.includes(boundaries[archetype]), `${archetype} CLAUDE.md lacks its boundary note`)
      // Never localhost: the app talks to services by name over the network (§5).
      assert.ok(claudeMd.includes('postgres:5432'))
      // It says where it is, because `work/` is only part of the project.
      assert.ok(claudeMd.includes('/data'), `${archetype} CLAUDE.md does not describe the layout`)
    }
  })
})

// ── clone (§6, phase 20) ──────────────────────────────────────────────────────
describe('clone (cli-spec.md §6)', () => {
  /** A source worth reproducing: a service, an extra port, an extra package. */
  function richSource(name = 'source'): ProjectManifest {
    return manifest(name, {
      extra_packages: ['libnss3'],
      services: { postgres: { host_port: 5433 } },
      app_port: 3000,
      extra_ports: { api: { container_port: 8081, host_port: 8081 } },
    })
  }

  /** Everything a clone must reproduce exactly — no host port among it. */
  function shape(m: ProjectManifest) {
    return {
      archetype: m.archetype,
      base_image: m.base_image,
      extra_packages: m.extra_packages,
      services: Object.keys(m.services ?? {}).sort(),
      extra_ports: Object.fromEntries(
        Object.entries(m.extra_ports ?? {}).map(([name, port]) => [name, port.container_port]),
      ),
    }
  }

  function hostPorts(m: ProjectManifest): number[] {
    return [
      ...(m.app_port === undefined ? [] : [m.app_port]),
      ...Object.values(m.services ?? {}).map((s) => s.host_port),
      ...Object.values(m.extra_ports ?? {}).map((p) => p.host_port),
    ].sort((a, b) => a - b)
  }

  test('reproduces the shape with fresh ports, and leaves the source untouched', async () => {
    const box = sandbox()
    box.writeProject('source', richSource())
    const before = box.read('source', 'project.yml')

    const result = await runClone(makeContext(box), { source: 'source', name: 'twin', withContent: false })
    assert.ok(validate('clone', result).valid, 'clone output must match clone.schema.json')
    assert.equal(result.source, 'source')
    assert.equal(result.with_content, false)
    assert.equal(result.bytes_copied, 0)
    assert.equal(result.project.dir, box.path('twin'), 'the clone did not land in the source root')

    const cloned = readManifest(box, 'twin')
    assert.deepEqual(shape(cloned), shape(richSource()))
    assert.equal(cloned.name, 'twin')
    assert.equal(cloned.created, FIXED_NOW.toISOString())

    const taken = new Set(hostPorts(richSource()))
    for (const port of hostPorts(cloned)) assert.ok(!taken.has(port), `clone kept host port ${port}`)
    assert.equal(hostPorts(cloned).length, 3)

    // Generated from the new manifest, never copied (INTENT.md invariant 7).
    const compose = box.read('twin', COMPOSE_FILENAME) ?? ''
    assert.ok(compose.includes(`${cloned.app_port}:3000`), 'compose does not publish the clone`s own app port')
    assert.ok(compose.includes('bardolier-twin'), 'compose still names the source')

    assert.equal(box.read('source', 'project.yml'), before, 'clone modified the source manifest')
    assert.deepEqual(result.seeded, ['work/CLAUDE.md'])
  })

  test('--with-content copies all four folders of §3, home/ included', async () => {
    const box = sandbox()
    box.writeProject('source', richSource())
    seedServiceData(box, 'source', 'postgres')
    mkdirSync(box.path('source', 'work'), { recursive: true })
    writeFileSync(box.path('source', 'work', 'README.md'), 'the users own file')
    mkdirSync(box.path('source', 'home'), { recursive: true })
    writeFileSync(box.path('source', 'home', '.zsh_history'), 'secrets')

    const result = await runClone(makeContext(box), { source: 'source', name: 'twin', withContent: true })
    assert.ok(validate('clone', result).valid)
    assert.equal(result.with_content, true)
    assert.ok(result.bytes_copied > 0, 'reported no bytes copied')

    assert.equal(box.read('twin', 'work', 'README.md'), 'the users own file')
    assert.equal(box.read('twin', 'data', 'postgres', 'DATA'), box.read('source', 'data', 'postgres', 'DATA'))
    // A clone is an identical copy: the login, the dotfiles and the shell
    // history travel with it (owner's decision, amending the original spec).
    assert.equal(box.read('twin', 'home', '.zsh_history'), 'secrets')
  })

  test('a seed the copy brought is left alone; one it did not is re-seeded', async () => {
    const box = sandbox()
    box.writeProject('source', richSource())
    mkdirSync(box.path('source', 'work'), { recursive: true })
    writeFileSync(box.path('source', 'work', 'CLAUDE.md'), '# hand-edited')

    const result = await runClone(makeContext(box), { source: 'source', name: 'twin', withContent: true })
    assert.deepEqual(result.seeded, [])
    assert.equal(box.read('twin', 'work', 'CLAUDE.md'), '# hand-edited')
  })

  test('--with-content needs the source stopped; a shape clone of the same project does not', async () => {
    const box = sandbox()
    box.writeProject('source', richSource())
    const docker = stubDocker({ running: [devContainerName('source')] })

    await assert.rejects(
      () => runClone(makeContext(box, docker), { source: 'source', name: 'twin', withContent: true }),
      (error: unknown) => error instanceof BardolierError && error.code === 'PROJECT_RUNNING',
    )
    assert.equal(box.exists('twin'), false, 'a refused clone left a directory behind')

    const result = await runClone(makeContext(box, docker), { source: 'source', name: 'twin', withContent: false })
    assert.equal(result.project.name, 'twin')
  })

  test('a name taken in another root is PROJECT_EXISTS, and leaves nothing behind', async () => {
    const box = sandbox()
    const other = secondRoot()
    box.writeProject('source', richSource())
    const ctx = twoRoots(box, other)
    mkdirSync(join(other, 'twin'), { recursive: true })
    writeManifest(ctx, join(other, 'twin'), manifest('twin'))

    await assert.rejects(
      () => runClone(ctx, { source: 'source', name: 'twin', withContent: false }),
      (error: unknown) => error instanceof BardolierError && error.code === 'PROJECT_EXISTS',
    )
    assert.equal(box.exists('twin'), false)
    assert.equal(existsSync(stagingPath(box.root, 'twin')), false)
  })

  test('--root places the clone elsewhere; the default is the source`s own root', async () => {
    const box = sandbox()
    const other = secondRoot()
    box.writeProject('source', richSource())

    const elsewhere = await runClone(twoRoots(box, other), { source: 'source', name: 'twin', root: 'b', withContent: false })
    assert.equal(elsewhere.project.root, 'b')
    assert.equal(elsewhere.project.dir, join(other, 'twin'))

    const home = await runClone(twoRoots(box, other), { source: 'source', name: 'triplet', withContent: false })
    assert.equal(home.project.root, 'a')

    await assert.rejects(
      () => runClone(twoRoots(box, other), { source: 'source', name: 'nope', root: 'c', withContent: false }),
      (error: unknown) => error instanceof BardolierError && error.code === 'INVALID_ARGUMENT',
    )
  })

  test('an unknown source is PROJECT_NOT_FOUND and an unusable name INVALID_ARGUMENT', async () => {
    const box = sandbox()
    box.writeProject('source', richSource())
    await assert.rejects(
      () => runClone(makeContext(box), { source: 'ghost', name: 'twin', withContent: false }),
      (error: unknown) => error instanceof BardolierError && error.code === 'PROJECT_NOT_FOUND',
    )
    await assert.rejects(
      () => runClone(makeContext(box), { source: 'source', name: 'Twin', withContent: false }),
      (error: unknown) => error instanceof BardolierError && error.code === 'INVALID_ARGUMENT',
    )
  })
})

// ── move (§6, phase 21) ───────────────────────────────────────────────────────
describe('move (cli-spec.md §6)', () => {
  test('moves a stopped project between roots — content, manifest and ports all survive', async () => {
    const box = sandbox()
    const other = secondRoot()
    box.writeProject('api', withServices('api'))
    mkdirSync(box.path('api', 'work'), { recursive: true })
    writeFileSync(box.path('api', 'work', 'app.ts'), 'export {}')
    mkdirSync(box.path('api', 'data', 'postgres'), { recursive: true })
    writeFileSync(box.path('api', 'data', 'postgres', 'PG_VERSION'), '17')
    // `move` never regenerates compose (nothing inside is rewritten), so a
    // realistic fixture needs one already on disk to prove it travels intact.
    writeFileSync(box.path('api', COMPOSE_FILENAME), '# DO NOT EDIT — generated by bardolier\nservices: {}\n')
    const before = readManifest(box, 'api')
    const beforeCompose = box.read('api', COMPOSE_FILENAME)

    const ctx = twoRoots(box, other)
    const result = await runMove(ctx, { name: 'api', root: 'b' })

    assert.ok(validate('move', result).valid, 'move output must match move.schema.json')
    assert.equal(result.moved, true)
    assert.equal(result.mode, 'rename', 'a temp dir and its sibling share one filesystem')
    assert.ok(result.bytes > 0)
    assert.equal(result.from.root, 'a')
    assert.equal(result.to.root, 'b')
    assert.equal(result.to.dir, join(other, 'api'))

    assert.equal(box.exists('api'), false, 'the source directory must be gone')
    assert.equal(readFileSync(join(other, 'api', 'project.yml'), 'utf8'), stringifyYaml(before))
    assert.equal(readFileSync(join(other, 'api', COMPOSE_FILENAME), 'utf8'), beforeCompose)
    assert.equal(readFileSync(join(other, 'api', 'work', 'app.ts'), 'utf8'), 'export {}')
    assert.equal(readFileSync(join(other, 'api', 'data', 'postgres', 'PG_VERSION'), 'utf8'), '17')

    const after = parseYaml(readFileSync(join(other, 'api', 'project.yml'), 'utf8')) as ProjectManifest
    assert.equal(after.app_port, before.app_port)
    assert.deepEqual(after.services, before.services)

    const discovery = discoverProjects(ctx.config)
    const found = discovery.projects.find((p) => p.name === 'api')
    assert.ok(found, '`api` must still be discoverable')
    assert.equal(found?.root, 'b')
  })

  test('moving to the root it already occupies is an idempotent no-op — no daemon required', async () => {
    const box = sandbox()
    box.writeProject('steady', manifest('steady'))
    // available: false — a no-op must succeed BEFORE any Docker query, so a
    // dead daemon cannot turn a should-be-instant success into a failure.
    const ctx = makeContext(box, stubDocker({ available: false }))
    const home = discoverProjects(ctx.config).projects.find((p) => p.name === 'steady')!

    const result = await runMove(ctx, { name: 'steady', root: home.root })

    assert.equal(result.moved, false)
    assert.equal(result.mode, 'rename')
    assert.equal(result.bytes, 0)
    assert.equal(result.from.root, home.root)
    assert.equal(result.to.root, home.root)
    assert.equal(box.exists('steady'), true)
  })

  test('a running project refuses PROJECT_RUNNING and does not move', async () => {
    const box = sandbox()
    const other = secondRoot()
    box.writeProject('busy', manifest('busy'))
    const docker = stubDocker({ running: [devContainerName('busy')] })
    box.writeConfig({ roots: [{ name: 'a', path: box.root }, { name: 'b', path: other }] })
    const ctx = makeContext(box, docker, { env: { BARDOLIER_ROOT: '' } })

    await assert.rejects(
      () => runMove(ctx, { name: 'busy', root: 'b' }),
      (error: unknown) => error instanceof BardolierError && error.code === 'PROJECT_RUNNING',
    )
    assert.equal(box.exists('busy'), true)
    assert.equal(existsSync(join(other, 'busy')), false)
  })

  test('an unreadable target root is ROOT_UNREADABLE and leaves the source alone', async () => {
    const box = sandbox()
    box.writeProject('lonely', manifest('lonely'))
    box.writeConfig({
      roots: [{ name: 'a', path: box.root }, { name: 'b', path: join(box.root, '..', 'unplugged-b') }],
    })
    const ctx = makeContext(box, stubDocker(), { env: { BARDOLIER_ROOT: '' } })

    await assert.rejects(
      () => runMove(ctx, { name: 'lonely', root: 'b' }),
      (error: unknown) => error instanceof BardolierError && error.code === 'ROOT_UNREADABLE',
    )
    assert.equal(box.exists('lonely'), true)
  })

  test('an unknown root and a missing --root are both INVALID_ARGUMENT', async () => {
    const box = sandbox()
    box.writeProject('picky', manifest('picky'))
    const ctx = makeContext(box)

    await assert.rejects(
      () => runMove(ctx, { name: 'picky', root: 'nowhere' }),
      (error: unknown) => error instanceof BardolierError && error.code === 'INVALID_ARGUMENT',
    )
    await assert.rejects(
      () => runMove(ctx, { name: 'picky', root: undefined }),
      (error: unknown) => error instanceof BardolierError && error.code === 'INVALID_ARGUMENT',
    )
  })

  test('an occupied target name is PROJECT_EXISTS', async () => {
    const box = sandbox()
    const other = secondRoot()
    box.writeProject('twice', manifest('twice'))
    mkdirSync(join(other, 'twice'), { recursive: true })
    writeFileSync(join(other, 'twice', 'squatter'), 'already here')
    const ctx = twoRoots(box, other)

    await assert.rejects(
      () => runMove(ctx, { name: 'twice', root: 'b' }),
      (error: unknown) => error instanceof BardolierError && error.code === 'PROJECT_EXISTS',
    )
    assert.equal(box.exists('twice'), true)
    assert.equal(readFileSync(join(other, 'twice', 'squatter'), 'utf8'), 'already here')
  })

  test('an unknown project is PROJECT_NOT_FOUND', async () => {
    const box = sandbox()
    await assert.rejects(
      () => runMove(makeContext(box), { name: 'ghost', root: 'a' }),
      (error: unknown) => error instanceof BardolierError && error.code === 'PROJECT_NOT_FOUND',
    )
  })
})

// ── transfer.ts (phase 20) ────────────────────────────────────────────────────
describe('staged copies (transfer.ts)', () => {
  test('a copy in progress is not a project `status` can see', () => {
    const box = sandbox()
    const ctx = makeContext(box)
    const staging = stagingPath(box.root, 'halfway')
    mkdirSync(staging, { recursive: true })
    writeManifest(ctx, staging, manifest('halfway'))

    assert.deepEqual(discoverProjects(ctx.config).projects, [])
  })

  test('a copy that throws leaves neither a project nor a staging directory', () => {
    const box = sandbox()
    assert.throws(
      () =>
        stageProject(box.root, 'halfway', (staging) => {
          writeFileSync(join(staging, 'partial'), 'x')
          throw new Error('the disk went away')
        }),
      /the disk went away/,
    )
    assert.equal(existsSync(stagingPath(box.root, 'halfway')), false)
    assert.equal(existsSync(join(box.root, 'halfway')), false)
    assert.deepEqual(discoverProjects(makeContext(box).config).projects, [])
  })

  test('a copy that would not fit is refused before any byte moves', () => {
    const box = sandbox()
    assert.throws(
      () => requireSpace(box.root, 10_000_000, () => 1_000_000),
      (error: unknown) =>
        error instanceof BardolierError &&
        error.code === 'INSUFFICIENT_SPACE' &&
        error.details?.needed_bytes === 10_000_000 &&
        error.details?.free_bytes === 1_000_000,
    )
    // Room to spare is silence, not a warning.
    assert.equal(requireSpace(box.root, 1_000, () => 1_000_000), undefined)
  })

  // `relocate` (phase 21): a temp dir can't straddle two real filesystems, so
  // EXDEV is forced through the `rename` seam rather than a real mount boundary.
  function exdevError(): NodeJS.ErrnoException {
    const error = new Error('cross-device link') as NodeJS.ErrnoException
    error.code = 'EXDEV'
    return error
  }

  function freshSource(box: Sandbox, name: string): string {
    const dir = join(box.root, '..', 'external-source', name)
    mkdirSync(join(dir, 'work'), { recursive: true })
    writeFileSync(join(dir, 'work', 'file.txt'), 'hello')
    writeFileSync(join(dir, 'project.yml'), 'name: ' + name + '\n')
    return dir
  }

  test('EXDEV falls back to a staged copy, then removes the source', () => {
    const box = sandbox()
    const source = freshSource(box, 'proj')

    const result = relocate(source, box.root, 'proj', {
      rename: () => {
        throw exdevError()
      },
    })

    assert.equal(result.mode, 'copy')
    assert.ok(result.bytes > 0)
    assert.equal(existsSync(source), false, 'the source must be removed only after the copy lands')
    assert.equal(readFileSync(join(box.root, 'proj', 'work', 'file.txt'), 'utf8'), 'hello')
    assert.equal(existsSync(stagingPath(box.root, 'proj')), false)
  })

  test('EXDEV + a copy that throws leaves the source untouched and no staging directory', () => {
    const box = sandbox()
    const source = freshSource(box, 'proj')

    assert.throws(
      () =>
        relocate(source, box.root, 'proj', {
          rename: () => {
            throw exdevError()
          },
          copy: () => {
            throw new Error('the disk went away')
          },
        }),
      /the disk went away/,
    )
    assert.equal(existsSync(source), true, 'a failed copy must not touch the source')
    assert.equal(existsSync(join(box.root, 'proj')), false)
    assert.equal(existsSync(stagingPath(box.root, 'proj')), false)
  })

  test('EXDEV + insufficient space is refused before any byte moves, source intact', () => {
    const box = sandbox()
    const source = freshSource(box, 'proj')

    assert.throws(
      () =>
        relocate(source, box.root, 'proj', {
          rename: () => {
            throw exdevError()
          },
          free: () => 0,
        }),
      (error: unknown) => error instanceof BardolierError && error.code === 'INSUFFICIENT_SPACE',
    )
    assert.equal(existsSync(source), true)
    assert.equal(existsSync(join(box.root, 'proj')), false)
  })

  test('a non-EXDEV rename failure propagates unchanged, source intact', () => {
    const box = sandbox()
    const source = freshSource(box, 'proj')
    const permissionDenied = new Error('permission denied') as NodeJS.ErrnoException
    permissionDenied.code = 'EACCES'

    assert.throws(
      () =>
        relocate(source, box.root, 'proj', {
          rename: () => {
            throw permissionDenied
          },
        }),
      /permission denied/,
    )
    assert.equal(existsSync(source), true)
    assert.equal(existsSync(join(box.root, 'proj')), false)
  })
})

// ── up (§6, §2, §5) ───────────────────────────────────────────────────────────
describe('up (cli-spec.md §6)', () => {
  test('starts a stopped project and reports what it published', async () => {
    const box = sandbox()
    box.writeProject('myapp', withServices())
    const docker = stubDocker({
      startsAs: [devContainerName('myapp'), serviceContainerName('myapp', 'postgres'), serviceContainerName('myapp', 'redis')],
    })

    const result = await runUp(makeContext(box, docker), { name: 'myapp', noShell: false })

    assert.ok(validate('up', result).valid, 'up output must match up.schema.json')
    assert.equal(result.state, 'running')
    assert.equal(result.already_running, false)
    assert.equal(result.dev_container, devContainerName('myapp'))
    assert.deepEqual(
      result.services.map((s) => [s.key, s.host_port, s.container_port]),
      [
        ['postgres', 5433, 5432],
        ['redis', 6380, 6379],
      ],
    )
    assert.deepEqual(
      docker.calls.map((c) => c.kind),
      // bardolier-web's shared `uv` cache volume (Phase 11) is ensured before `up`.
      ['ensureVolume', 'up'],
    )
  })

  test('regenerates the compose file from the manifest before starting', async () => {
    const box = sandbox()
    box.writeProject('myapp', manifest('myapp'))
    const docker = stubDocker({ startsAs: [devContainerName('myapp')] })

    const result = await runUp(makeContext(box, docker), { name: 'myapp', noShell: false })
    assert.equal(result.compose_regenerated, true)
    assert.ok(box.exists('myapp', COMPOSE_FILENAME))

    const call = docker.calls.find((c) => c.kind === 'up')
    assert.ok(call?.kind === 'up')
    assert.equal(call.target.file, box.path('myapp', COMPOSE_FILENAME))
    assert.equal(call.target.project, composeProject('myapp'))
    assert.equal(call.target.cwd, box.path('myapp'))
  })

  test('a second up on an unchanged project rewrites nothing', async () => {
    const box = sandbox()
    box.writeProject('myapp', manifest('myapp'))
    const dev = devContainerName('myapp')

    await runUp(makeContext(box, stubDocker({ startsAs: [dev] })), { name: 'myapp', noShell: false })
    const second = await runUp(makeContext(box, stubDocker({ running: [dev], startsAs: [dev] })), {
      name: 'myapp',
      noShell: false,
    })
    assert.equal(second.compose_regenerated, false)
  })

  test('is idempotent: up on a running project is a no-op success (§2)', async () => {
    const box = sandbox()
    box.writeProject('myapp', manifest('myapp'))
    const docker = stubDocker({ running: [devContainerName('myapp')] })

    const result = await runUp(makeContext(box, docker), { name: 'myapp', noShell: false })
    assert.equal(result.already_running, true)
    assert.equal(result.state, 'running')
    assert.deepEqual(docker.calls, [], 'a no-op up must not touch Docker')
  })

  test('--no-shell only changes the cue it hands the app; the CLI spawns nothing', async () => {
    const box = sandbox()
    box.writeProject('myapp', manifest('myapp'))
    const dev = devContainerName('myapp')

    const withShell = await runUp(makeContext(box, stubDocker({ startsAs: [dev] })), { name: 'myapp', noShell: false })
    const without = await runUp(makeContext(box, stubDocker({ running: [dev] })), { name: 'myapp', noShell: true })
    assert.equal(withShell.open_shell, true)
    assert.equal(without.open_shell, false)
  })

  test('a squatted host port fails PORT_UNAVAILABLE and names it — never a silent remap (§5)', async () => {
    const box = sandbox()
    box.writeProject('myapp', withServices())
    const docker = stubDocker()
    const ctx = makeContext(box, docker, { ports: stubPorts([5433]) })

    await assert.rejects(
      () => runUp(ctx, { name: 'myapp', noShell: false }),
      (error: unknown) =>
        error instanceof BardolierError &&
        error.code === 'PORT_UNAVAILABLE' &&
        error.message.includes('5433') &&
        error.details?.port === 5433,
    )
    assert.deepEqual(docker.calls, [], 'nothing may start when a port is unavailable')
  })

  test('a port held by this project’s own running service does not block a restart', async () => {
    const box = sandbox()
    box.writeProject('myapp', withServices())
    // postgres is up (so it holds 5433); redis is not.
    const docker = stubDocker({ running: [serviceContainerName('myapp', 'postgres')] })
    const ctx = makeContext(box, docker, { ports: stubPorts([5433]) })

    const result = await runUp(ctx, { name: 'myapp', noShell: false })
    // bardolier-web's shared `uv` cache volume (Phase 11) is ensured, then `up`.
    assert.equal(docker.calls.length, 2)
    assert.equal(result.already_running, false)
  })

  test('reports `partial` honestly when not everything came up', async () => {
    const box = sandbox()
    box.writeProject('myapp', withServices())
    const docker = stubDocker({ startsAs: [devContainerName('myapp'), serviceContainerName('myapp', 'postgres')] })

    const result = await runUp(makeContext(box, docker), { name: 'myapp', noShell: false })
    assert.equal(result.state, 'partial')
  })

  test('an unknown project is PROJECT_NOT_FOUND; an absent SSD is SSD_NOT_MOUNTED', async () => {
    const box = sandbox()
    await assert.rejects(
      () => runUp(makeContext(box), { name: 'ghost', noShell: false }),
      (error: unknown) => error instanceof BardolierError && error.code === 'PROJECT_NOT_FOUND',
    )
    const unplugged = makeContext(box, stubDocker(), { env: { BARDOLIER_ROOT: join(box.root, 'unplugged') } })
    await assert.rejects(
      () => runUp(unplugged, { name: 'myapp', noShell: false }),
      (error: unknown) => error instanceof BardolierError && error.code === 'SSD_NOT_MOUNTED',
    )
  })

  test('a dead daemon surfaces as DOCKER_UNAVAILABLE', async () => {
    const box = sandbox()
    box.writeProject('myapp', manifest('myapp'))
    await assert.rejects(
      () => runUp(makeContext(box, stubDocker({ available: false })), { name: 'myapp', noShell: false }),
      (error: unknown) => error instanceof BardolierError && error.code === 'DOCKER_UNAVAILABLE',
    )
  })
})

// ── down (§6, §2) ─────────────────────────────────────────────────────────────
describe('down (cli-spec.md §6)', () => {
  test('stops the project and keeps its data', async () => {
    const box = sandbox()
    box.writeProject('myapp', withServices())
    const docker = stubDocker({ running: [devContainerName('myapp')], volumes: ['myapp_pgdata'] })

    const result = await runDown(makeContext(box, docker), 'myapp')
    assert.ok(validate('down', result).valid, 'down output must match down.schema.json')
    assert.equal(result.was_running, true)
    assert.equal(result.state, 'stopped')
    assert.equal(result.data_kept, true)
    // The order is the point (§12): the handoff asks the agent while its
    // container is still up. One `compose down` later there is nobody to ask.
    assert.deepEqual(
      docker.calls.map((c) => c.kind),
      ['exec', 'down'],
    )
    assert.deepEqual(await docker.volumeNames(), ['myapp_pgdata'], 'down must not remove volumes')
    assert.ok(box.exists('myapp', 'project.yml'), 'down must not touch the project directory')
  })

  test('is idempotent: down on a stopped project is a no-op success (§2)', async () => {
    const box = sandbox()
    box.writeProject('myapp', manifest('myapp'))
    const result = await runDown(makeContext(box, stubDocker()), 'myapp')
    assert.equal(result.was_running, false)
    assert.equal(result.state, 'stopped')
  })

  test('regenerates a missing compose file rather than failing', async () => {
    const box = sandbox()
    box.writeProject('myapp', manifest('myapp'))
    assert.ok(!box.exists('myapp', COMPOSE_FILENAME))

    await runDown(makeContext(box, stubDocker()), 'myapp')
    assert.ok(box.exists('myapp', COMPOSE_FILENAME))
  })

  test('up then down leaves the project stopped and the files intact', async () => {
    const box = sandbox()
    box.writeProject('myapp', manifest('myapp'))
    const dev = devContainerName('myapp')
    const docker = stubDocker({ startsAs: [dev] })
    const ctx = makeContext(box, docker)

    await runUp(ctx, { name: 'myapp', noShell: true })
    assert.equal((await collectStatus(ctx, 'myapp')).projects[0]?.state, 'running')

    await runDown(ctx, 'myapp')
    assert.equal((await collectStatus(ctx, 'myapp')).projects[0]?.state, 'stopped')
    assert.ok(box.exists('myapp', 'project.yml'))
  })

  test('an unknown project is PROJECT_NOT_FOUND', async () => {
    const box = sandbox()
    await assert.rejects(
      () => runDown(makeContext(box), 'ghost'),
      (error: unknown) => error instanceof BardolierError && error.code === 'PROJECT_NOT_FOUND',
    )
  })
})

// ── delete (§6, §5) ───────────────────────────────────────────────────────────
describe('delete (cli-spec.md §6)', () => {
  const request = (name: string, overrides: Partial<Parameters<typeof runDelete>[1]> = {}) => ({
    name,
    force: false,
    purge: false,
    json: false,
    ...overrides,
  })

  /** Give a project something to lose: a byte under `data/` is enough. */
  function seedData(box: ReturnType<typeof sandbox>, project: string) {
    mkdirSync(join(box.root, project, 'data', 'postgres'), { recursive: true })
    writeFileSync(join(box.root, project, 'data', 'postgres', 'PG_VERSION'), '17\n')
  }

  test('brings the project down and removes the dir when it holds nothing', async () => {
    const box = sandbox()
    box.writeProject('myapp', withServices())
    const docker = stubDocker({ running: [devContainerName('myapp')] })

    const result = await runDelete(makeContext(box, docker), request('myapp', { force: true }))

    assert.ok(validate('delete', result).valid, 'delete output must match delete.schema.json')
    assert.equal(result.deleted, true)
    assert.deepEqual(result.released_ports, [5433, 6380])
    // A project owns no named volume since phase 19; its data went with the dir.
    assert.deepEqual(result.removed_volumes, [])
    assert.deepEqual(result.kept_volumes, [])
    assert.ok(!box.exists('myapp'), 'the project directory must be gone')
    assert.deepEqual(
      docker.calls.map((c) => c.kind),
      ['down'],
      'delete must stop containers before removing the directory',
    )
  })

  test('a project holding data refuses PROJECT_HAS_DATA, and is untouched', async () => {
    const box = sandbox()
    box.writeProject('myapp', withServices())
    seedData(box, 'myapp')
    const docker = stubDocker()

    await assert.rejects(
      () => runDelete(makeContext(box, docker), request('myapp', { force: true })),
      (error: unknown) => error instanceof BardolierError && error.code === 'PROJECT_HAS_DATA',
    )
    assert.ok(box.exists('myapp', 'project.yml'), 'a refusal must leave the project alone')
    assert.deepEqual(docker.calls, [], 'nothing may be stopped before the refusal')
  })

  test('the refusal names what it would destroy and how big it is', async () => {
    const box = sandbox()
    box.writeProject('myapp', withServices())
    seedData(box, 'myapp')
    await assert.rejects(
      () => runDelete(makeContext(box, stubDocker()), request('myapp', { force: true })),
      (error: unknown) => {
        assert.ok(error instanceof BardolierError)
        assert.ok(error.message.includes(join(box.root, 'myapp', 'data')), error.message)
        assert.ok(error.message.includes(join(box.root, 'myapp', 'home')), error.message)
        assert.match(error.message, /\d+ B/, error.message)
        assert.equal(error.details?.bytes, 3)
        return true
      },
    )
  })

  test('--purge is the only path through, and it takes the data with the dir', async () => {
    const box = sandbox()
    box.writeProject('myapp', withServices())
    seedData(box, 'myapp')

    const result = await runDelete(makeContext(box, stubDocker()), request('myapp', { force: true, purge: true }))
    assert.equal(result.deleted, true)
    assert.ok(!box.exists('myapp'), 'the project directory and everything in it must be gone')
  })

  test('--purge never asks Docker to remove a volume — a project owns none', async () => {
    const box = sandbox()
    box.writeProject('myapp', withServices())
    const docker = stubDocker({ volumes: ['bardolier-uv-cache'] })

    const result = await runDelete(makeContext(box, docker), request('myapp', { force: true, purge: true }))

    assert.equal(result.deleted, true)
    assert.deepEqual(result.removed_volumes, [])
    assert.deepEqual(
      docker.calls.filter((call) => call.kind === 'removeVolume'),
      [],
      'the shared cache belongs to every project on the image and to none of them',
    )
    assert.deepEqual(await docker.volumeNames(), ['bardolier-uv-cache'])
  })

  test('confirms before deleting, and a refusal touches nothing', async () => {
    const box = sandbox()
    box.writeProject('myapp', manifest('myapp'))
    const confirm = stubConfirm(false)
    const docker = stubDocker()

    const result = await runDelete(makeContext(box, docker, { confirm }), request('myapp'))
    assert.equal(result.deleted, false)
    assert.equal(confirm.questions.length, 1)
    assert.ok(box.exists('myapp', 'project.yml'), 'a declined delete must leave the project alone')
    assert.deepEqual(docker.calls, [])
  })

  test('the purge prompt says what is about to be destroyed', async () => {
    const box = sandbox()
    box.writeProject('myapp', withServices())
    seedData(box, 'myapp')

    const purge = stubConfirm(false)
    await runDelete(makeContext(box, stubDocker(), { confirm: purge }), request('myapp', { purge: true }))
    assert.ok(purge.questions[0]?.includes('destroyed') || purge.questions[0]?.includes('including'), purge.questions[0])
    assert.ok(purge.questions[0]?.includes('3 B'), purge.questions[0])
  })

  test('--force skips the prompt', async () => {
    const box = sandbox()
    box.writeProject('myapp', manifest('myapp'))
    // makeContext's default confirm throws if called at all.
    const result = await runDelete(makeContext(box, stubDocker()), request('myapp', { force: true }))
    assert.equal(result.deleted, true)
  })

  test('under --json, refuses to delete unconfirmed rather than prompting into stdout (§2)', async () => {
    const box = sandbox()
    box.writeProject('myapp', manifest('myapp'))
    await assert.rejects(
      () => runDelete(makeContext(box, stubDocker()), request('myapp', { json: true })),
      (error: unknown) => error instanceof BardolierError && error.code === 'INVALID_ARGUMENT',
    )
    assert.ok(box.exists('myapp', 'project.yml'))
  })

  test('releasing ports means the manifest is gone — there is no second registry (§5)', async () => {
    const box = sandbox()
    box.writeProject('myapp', withServices())
    await runDelete(makeContext(box, stubDocker()), request('myapp', { force: true }))

    const status = await collectStatus(makeContext(box))
    assert.deepEqual(status.projects, [])
  })

  test('an unknown project is PROJECT_NOT_FOUND', async () => {
    const box = sandbox()
    await assert.rejects(
      () => runDelete(makeContext(box), request('ghost', { force: true })),
      (error: unknown) => error instanceof BardolierError && error.code === 'PROJECT_NOT_FOUND',
    )
  })
})

// ── The lifecycle end to end ──────────────────────────────────────────────────
describe('lifecycle (new → up → down → delete)', () => {
  test('status tracks every transition', async () => {
    const box = sandbox()
    const dev = devContainerName('myapp')
    const docker = stubDocker({ startsAs: [dev] })
    const ctx = makeContext(box, docker, { confirm: stubConfirm(true) })

    await runNew(ctx, { name: 'myapp', archetype: 'web', services: undefined })
    assert.equal((await collectStatus(ctx, 'myapp')).projects[0]?.state, 'stopped')

    await runUp(ctx, { name: 'myapp', noShell: true })
    assert.equal((await collectStatus(ctx, 'myapp')).projects[0]?.state, 'running')
    assert.equal((await collectStatus(ctx, 'myapp')).projects[0]?.dev_container, dev)

    await runDown(ctx, 'myapp')
    assert.equal((await collectStatus(ctx, 'myapp')).projects[0]?.state, 'stopped')

    const deleted = await runDelete(ctx, { name: 'myapp', force: false, purge: false, json: false })
    assert.equal(deleted.deleted, true)
    assert.deepEqual((await collectStatus(ctx)).projects, [])
  })

  test('requireProject is the one gate the mutating commands share', () => {
    const box = sandbox()
    box.writeProject('bad', 'name: [unclosed')
    assert.throws(
      () => requireProject(makeContext(box), 'bad'),
      (error: unknown) => error instanceof BardolierError && error.code === 'CONFIG_INVALID',
    )
    assert.throws(
      () => requireProject(makeContext(box), undefined),
      (error: unknown) => error instanceof BardolierError && error.code === 'INVALID_ARGUMENT',
    )
  })

  test('attachedKeys is the sorted attachment list every generator counts on', () => {
    assert.deepEqual(attachedKeys(withServices()), ['postgres', 'redis'])
    assert.deepEqual(attachedKeys(manifest('bare')), [])
  })

  test('a project directory that is not a project is ignored, not clobbered', async () => {
    const box = sandbox()
    mkdirSync(join(box.root, 'notes'), { recursive: true })
    writeFileSync(join(box.root, 'notes', 'todo.md'), 'buy milk')

    const status = await collectStatus(makeContext(box))
    assert.deepEqual(status.projects, [])
    await assert.rejects(
      () => runDown(makeContext(box), 'notes'),
      (error: unknown) => error instanceof BardolierError && error.code === 'PROJECT_NOT_FOUND',
    )
    assert.equal(readFileSync(join(box.root, 'notes', 'todo.md'), 'utf8'), 'buy milk')
  })
})

describe('`new --root` (cli-spec.md §6)', () => {
  test('defaults to the first configured root', async () => {
    const box = sandbox()
    const rootB = secondRoot()
    const ctx = twoRoots(box, rootB)
    const created = await runNew(ctx, { name: 'alpha', archetype: 'web', services: undefined })
    assert.equal(created.project.root, 'a')
    assert.ok(box.exists('alpha', 'project.yml'))
  })

  test('an unknown --root is INVALID_ARGUMENT naming the configured roots', async () => {
    const box = sandbox()
    const rootB = secondRoot()
    const ctx = twoRoots(box, rootB)
    await assert.rejects(
      () => runNew(ctx, { name: 'alpha', archetype: 'web', services: undefined, root: 'ghost' }),
      (error: unknown) => {
        assert.ok(error instanceof BardolierError)
        assert.equal(error.code, 'INVALID_ARGUMENT')
        assert.match(error.message, /a, b/)
        return true
      },
    )
  })

  test('an unreadable target root is ROOT_UNREADABLE, not SSD_NOT_MOUNTED', async () => {
    const box = sandbox()
    const rootB = secondRoot()
    const ctx = twoRoots(box, rootB)
    rmSync(rootB, { recursive: true, force: true })
    await assert.rejects(
      () => runNew(ctx, { name: 'alpha', archetype: 'web', services: undefined, root: 'b' }),
      (error: unknown) => error instanceof BardolierError && error.code === 'ROOT_UNREADABLE',
    )
  })

  test('PROJECT_EXISTS means "in any root"', async () => {
    const box = sandbox()
    const rootB = secondRoot()
    const ctx = twoRoots(box, rootB)
    await runNew(ctx, { name: 'alpha', archetype: 'web', services: undefined, root: 'a' })
    await assert.rejects(
      () => runNew(ctx, { name: 'alpha', archetype: 'web', services: undefined, root: 'b' }),
      (error: unknown) => error instanceof BardolierError && error.code === 'PROJECT_EXISTS',
    )
  })
})

// ── the whole loop ────────────────────────────────────────────────────────────
describe('new → up → shell → down → remove → reclaim → delete → eject', () => {
  test('one story, end to end', async () => {
    const box = sandbox()
    const docker = stubDocker({ startsAs: ['bardolier-alpha', 'bardolier-alpha-postgres'] })
    const device = stubDevice()
    const ctx = makeContext(box, docker, { device, confirm: stubConfirm(true) })

    await project(ctx, 'alpha', { services: 'postgres' })
    const up = await runUp(ctx, { name: 'alpha', noShell: false })
    assert.equal(up.state, 'running')
    // What the running postgres wrote into its bind source.
    seedServiceData(box, 'alpha', 'postgres', 20971520)

    const shell = await runShell(ctx, 'alpha')
    assert.deepEqual(shell.exec, ['docker', 'exec', '-it', 'bardolier-alpha', 'bash'])

    const status = await collectStatus(ctx, 'alpha')
    assert.equal(status.projects[0]?.services[0]?.host_port, up.services[0]?.host_port)
    assert.deepEqual(status.orphaned_volumes, [], 'attached data is not an orphan while the project is up')

    await runDownAll(ctx)
    await runServiceRemove(ctx, { project: 'alpha', service: 'postgres' })

    const orphaned = await collectOrphanedVolumes(ctx)
    assert.deepEqual(orphaned.orphaned.map((v) => v.name), ['alpha/postgres'])
    assert.equal(orphaned.total_human, '20 MB')

    const reclaimed = await runVolumeRemove(ctx, { name: 'alpha/postgres', force: true, json: true })
    assert.equal(reclaimed.removed, true)
    assert.deepEqual((await collectOrphanedVolumes(ctx)).orphaned, [])

    await runDelete(ctx, { name: 'alpha', force: true, purge: false, json: true })
    assert.equal(box.exists('alpha'), false)

    device.setHolders([holder({ command: 'zsh' })])
    await assert.rejects(
      () => runEject(ctx),
      (error: unknown) => error instanceof BardolierError && error.code === 'EJECT_BLOCKED',
    )
    device.setHolders([])
    assert.equal((await runEject(ctx)).ejected, true)
    assert.deepEqual(device.ejected, [containingVolume(box.root)])
  })
})
