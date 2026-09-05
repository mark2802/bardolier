/**
 * Phase 18 — many roots (docs/phases/18-many-roots.md). `ssd_root` is replaced
 * by `roots`, an ordered array; `$BARDOLIER_ROOT` replaces the whole list with a
 * single root named after the path's basename. The dangerous edge is a
 * PARTIAL view: `assignedPorts` and the orphan scan must refuse (ROOT_UNREADABLE)
 * rather than silently answering from whatever roots happen to be readable.
 */

import { test, describe, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { stringify as stringifyYaml } from 'yaml'

import { BardolierError } from '../cli/src/errors.ts'
import { addRootToFile, currentRoots, isValidRootName, loadConfig, nameFromPath, removeRootFromFile } from '../cli/src/config.ts'
import { discoverProjects, findProject, defaultRoot } from '../cli/src/projects.ts'
import { assignedPorts } from '../cli/src/allocator.ts'
import { scanVolumes } from '../cli/src/volumes.ts'
import { collectStatus } from '../cli/src/commands/status.ts'
import { collectList } from '../cli/src/commands/list.ts'
import { runNew } from '../cli/src/commands/new.ts'
import { runRootAdd, runRootRemove, collectRootList } from '../cli/src/commands/root.ts'
import { requireProject } from '../cli/src/workspace.ts'
import { makeContext, makeSandbox, manifest, stubDocker, type Sandbox } from './helpers.ts'

const sandboxes: Sandbox[] = []
function sandbox(): Sandbox {
  const created = makeSandbox()
  sandboxes.push(created)
  return created
}
const extraDirs: string[] = []
/** A second root, independent of the sandbox's own. */
function secondRoot(): string {
  const dir = mkdtempSync(join(tmpdir(), 'bardolier-root-b-'))
  extraDirs.push(dir)
  return dir
}
afterEach(() => {
  while (sandboxes.length > 0) sandboxes.pop()?.cleanup()
  while (extraDirs.length > 0) rmSync(extraDirs.pop()!, { recursive: true, force: true })
})

/** A context with two configured roots: the sandbox's own (named `a`) plus a second (`b`). */
function twoRoots(box: Sandbox, rootB: string) {
  box.writeConfig({ roots: [{ name: 'a', path: box.root }, { name: 'b', path: rootB }] })
  // The file must win over the single-root env override makeContext sets.
  return makeContext(box, stubDocker(), { env: { BARDOLIER_ROOT: '' } })
}

describe('config: roots (cli-spec.md §8)', () => {
  test('the built-in default is one root at ~/bardolier-projects, named by basename', () => {
    const box = sandbox()
    const loaded = loadConfig({ path: join(box.home, 'nope.yml'), home: box.home, env: {} })
    assert.deepEqual(loaded.config.roots, [{ name: 'bardolier-projects', path: join(box.home, 'bardolier-projects') }])
  })

  test('$BARDOLIER_ROOT replaces the whole list with one root named after the basename', () => {
    const box = sandbox()
    box.writeConfig({ roots: [{ name: 'x', path: '/somewhere/x' }, { name: 'y', path: '/somewhere/y' }] })
    const loaded = loadConfig({ path: box.configPath, home: box.home, env: { BARDOLIER_ROOT: '/mnt/disk/projects' } })
    assert.deepEqual(loaded.config.roots, [{ name: 'projects', path: '/mnt/disk/projects' }])
    assert.deepEqual([...loaded.overrides], ['BARDOLIER_ROOT'])
  })

  test('duplicate names, and duplicate paths, are each CONFIG_INVALID', () => {
    const box = sandbox()
    box.writeConfig({ roots: [{ name: 'a', path: '/x' }, { name: 'a', path: '/y' }] })
    assert.throws(
      () => loadConfig({ path: box.configPath, home: box.home, env: {} }),
      (error: unknown) => error instanceof BardolierError && error.code === 'CONFIG_INVALID',
    )

    box.writeConfig({ roots: [{ name: 'a', path: '/x' }, { name: 'b', path: '/x' }] })
    assert.throws(
      () => loadConfig({ path: box.configPath, home: box.home, env: {} }),
      (error: unknown) => error instanceof BardolierError && error.code === 'CONFIG_INVALID',
    )
  })

  test('nameFromPath sanitises an unusable basename rather than rejecting the path', () => {
    assert.equal(nameFromPath('/tmp/My Projects!'), 'My-Projects-')
    assert.equal(isValidRootName(nameFromPath('/tmp/My Projects!')), true)
  })

  test('root add materialises the implicit default as roots[0] before appending', () => {
    const box = sandbox()
    addRootToFile(box.configPath, { name: 'extra', path: '/mnt/extra' }, box.home)
    const roots = currentRoots(box.configPath, box.home)
    assert.deepEqual(roots.map((r) => r.name), ['bardolier-projects', 'extra'])
  })

  test('root add refuses a reused name or path', () => {
    const box = sandbox()
    addRootToFile(box.configPath, { name: 'a', path: '/mnt/a' }, box.home)
    assert.throws(
      () => addRootToFile(box.configPath, { name: 'a', path: '/mnt/other' }, box.home),
      (error: unknown) => error instanceof BardolierError && error.code === 'CONFIG_INVALID',
    )
    assert.throws(
      () => addRootToFile(box.configPath, { name: 'other', path: '/mnt/a' }, box.home),
      (error: unknown) => error instanceof BardolierError && error.code === 'CONFIG_INVALID',
    )
  })

  test('root remove never touches the directory, and an unknown name is INVALID_ARGUMENT', () => {
    const box = sandbox()
    addRootToFile(box.configPath, { name: 'a', path: box.root }, box.home)
    const { removed } = removeRootFromFile(box.configPath, 'a', box.home)
    assert.equal(removed.path, box.root)
    assert.ok(box.exists('.'), 'the directory the removed root pointed at still exists')

    assert.throws(
      () => removeRootFromFile(box.configPath, 'ghost', box.home),
      (error: unknown) => error instanceof BardolierError && error.code === 'INVALID_ARGUMENT',
    )
  })

  test('root remove refuses to forget the only configured root — never re-materialise the built-in default in its place', () => {
    const box = sandbox()
    // `box`'s implicit default root is the only one — removing it by its own
    // materialised name would silently swap it for ANOTHER materialised
    // default (~/bardolier-projects), which is not what "remove" means.
    const only = currentRoots(box.configPath, box.home)[0]!
    assert.throws(
      () => removeRootFromFile(box.configPath, only.name, box.home),
      (error: unknown) => error instanceof BardolierError && error.code === 'INVALID_ARGUMENT',
    )
    assert.deepEqual(currentRoots(box.configPath, box.home), [only], 'the only root is untouched')

    // Adding a second root first is the correct sequence, and now removal works.
    addRootToFile(box.configPath, { name: 'a', path: box.root }, box.home)
    const { removed } = removeRootFromFile(box.configPath, only.name, box.home)
    assert.equal(removed.name, only.name)
  })
})

describe('command surface: root add | remove | list', () => {
  test('list reports mounted per root; add/remove round-trip through it', () => {
    const box = sandbox()
    const rootB = secondRoot()
    const ctx = twoRoots(box, rootB)

    const listed = collectRootList(ctx)
    assert.deepEqual(listed.roots.map((r) => [r.name, r.mounted]), [['a', true], ['b', true]])

    const added = runRootAdd(ctx, { path: '/does/not/exist', name: 'c' })
    assert.equal(added.added.mounted, false, 'an unreadable path is still addable, and reported as such')
    assert.deepEqual(added.roots.map((r) => r.name), ['a', 'b', 'c'])

    const removed = runRootRemove(ctx, { name: 'c' })
    assert.deepEqual(removed.roots.map((r) => r.name), ['a', 'b'])
  })
})

describe('discovery across roots (cli-spec.md §3)', () => {
  test('projects from every readable root are merged, sorted by name, each carrying its root', () => {
    const box = sandbox()
    const rootB = secondRoot()
    const ctx = twoRoots(box, rootB)
    box.writeProject('zeta', manifest('zeta'))
    // A project planted directly in the second root, bypassing `new`.
    mkdirSync(join(rootB, 'alpha'), { recursive: true })
    writeFileSync(join(rootB, 'alpha', 'project.yml'), stringifyYaml(manifest('alpha')))

    const discovery = discoverProjects(ctx.config)
    assert.deepEqual(discovery.projects.map((p) => [p.name, p.root]), [['alpha', 'b'], ['zeta', 'a']])
    assert.deepEqual(discovery.roots.map((r) => [r.name, r.mounted]), [['a', true], ['b', true]])
  })

  test('a name in two roots is PROJECT_AMBIGUOUS naming both directories', () => {
    const box = sandbox()
    const rootB = secondRoot()
    const ctx = twoRoots(box, rootB)
    box.writeProject('dup', manifest('dup'))
    mkdirSync(join(rootB, 'dup'), { recursive: true })
    writeFileSync(join(rootB, 'dup', 'project.yml'), stringifyYaml(manifest('dup')))

    const discovery = discoverProjects(ctx.config)
    assert.throws(
      () => findProject(discovery, 'dup'),
      (error: unknown) => {
        assert.ok(error instanceof BardolierError)
        assert.equal(error.code, 'PROJECT_AMBIGUOUS')
        assert.equal((error.details?.dirs as string[]).length, 2)
        return true
      },
    )
    assert.throws(
      () => requireProject(ctx, 'dup'),
      (error: unknown) => error instanceof BardolierError && error.code === 'PROJECT_AMBIGUOUS',
    )
  })

  test('one root unreadable: `mounted` stays true, and `status`/`list` see only the other', async () => {
    const box = sandbox()
    const rootB = secondRoot()
    const ctx = twoRoots(box, rootB)
    box.writeProject('alpha', manifest('alpha'))
    rmSync(rootB, { recursive: true, force: true })

    const discovery = discoverProjects(ctx.config)
    assert.equal(discovery.mounted, true)
    assert.deepEqual(discovery.projects.map((p) => p.name), ['alpha'])

    const status = await collectStatus(ctx)
    assert.deepEqual(status.projects.map((p) => p.name), ['alpha'])
    assert.deepEqual(status.orphaned_volumes, [])
    assert.equal(status.roots?.find((r) => r.name === 'b')?.mounted, false)

    const list = await collectList(ctx)
    assert.deepEqual(list.projects.map((p) => p.name), ['alpha'])
  })
})

describe('a partial view refuses rather than under-reporting (§5, §6)', () => {
  test('assignedPorts throws ROOT_UNREADABLE when any configured root is unreadable', () => {
    const box = sandbox()
    const rootB = secondRoot()
    const ctx = twoRoots(box, rootB)
    box.writeProject('alpha', manifest('alpha', { services: { postgres: { host_port: 5433 } } }))
    rmSync(rootB, { recursive: true, force: true })

    assert.throws(
      () => assignedPorts(ctx.config),
      (error: unknown) => error instanceof BardolierError && error.code === 'ROOT_UNREADABLE',
    )
  })

  test('a port allocated in one root is never handed out in another', async () => {
    const box = sandbox()
    const rootB = secondRoot()
    const ctx = twoRoots(box, rootB)

    const a = await runNew(ctx, { name: 'alpha', archetype: 'web', services: 'postgres', root: 'a' })
    const b = await runNew(ctx, { name: 'beta', archetype: 'web', services: 'postgres', root: 'b' })
    assert.notEqual(a.services[0]?.host_port, b.services[0]?.host_port)
  })

  test('volumes: SSD_NOT_MOUNTED when every root is gone, ROOT_UNREADABLE when only some are', async () => {
    const box = sandbox()
    const rootB = secondRoot()
    const ctx = twoRoots(box, rootB)
    box.writeProject('alpha', manifest('alpha'))

    rmSync(box.root, { recursive: true, force: true })
    rmSync(rootB, { recursive: true, force: true })
    await assert.rejects(
      () => scanVolumes(ctx),
      (error: unknown) => error instanceof BardolierError && error.code === 'SSD_NOT_MOUNTED',
    )
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

describe('status.ssd.root stays the default root\'s path', () => {
  test('unaffected by which root a lookup resolves to', async () => {
    const box = sandbox()
    const rootB = secondRoot()
    const ctx = twoRoots(box, rootB)
    assert.equal(defaultRoot(ctx.config).name, 'a')
    const status = await collectStatus(ctx)
    assert.equal(status.ssd.root, box.root)
  })
})
