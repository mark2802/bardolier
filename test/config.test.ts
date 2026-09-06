/**
 * Configuration and roots: precedence, the env override, and `root add | remove | list`.
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { join } from 'node:path'
import { mkdirSync, readFileSync } from 'node:fs'
import { parse as parseYaml } from 'yaml'

import { BardolierError } from '../cli/src/errors.ts'
import { validate } from '../cli/src/schema.ts'
import {
  DEFAULT_TERMINAL,
  defaultConfigPath,
  loadConfig,
  CONFIG_KEYS,
  addRootToFile,
  currentRoots,
  isValidRootName,
  nameFromPath,
  removeRootFromFile,
} from '../cli/src/config.ts'
import { defaultRoot, probeRoot, containingVolume } from '../cli/src/projects.ts'
import { collectConfigGet, runConfigSet } from '../cli/src/commands/config.ts'
import { runRootAdd, runRootRemove, collectRootList } from '../cli/src/commands/root.ts'
import { makeContext, type Sandbox, sandboxes, stubDocker, tempDirs, twoRoots } from './helpers.ts'

const sandbox = sandboxes()
const secondRoot = tempDirs('bardolier-root-b-')

/** A context whose config comes from the FILE, not from the test env (§8). */
function fileConfigured(box: Sandbox) {
  return makeContext(box, stubDocker(), { env: { BARDOLIER_ROOT: '' } })
}

describe('config (cli-spec.md §8)', () => {
  test('loads with no config file at all — the every-root-absent first run', () => {
    const box = sandbox()
    const loaded = loadConfig({ path: join(box.home, 'nope', 'config.yml'), home: box.home, env: {} })
    assert.equal(loaded.exists, false)
    assert.deepEqual(loaded.config.roots, [{ name: 'bardolier-projects', path: join(box.home, 'bardolier-projects') }])
    assert.equal(loaded.config.terminal, DEFAULT_TERMINAL)
    assert.equal(loaded.config.catalogue_path, null)
  })

  test('reads roots and every other §8 key from the file', () => {
    const box = sandbox()
    box.writeConfig({
      roots: [{ name: 'disk', path: '/mnt/disk/projects' }],
      catalogue_path: '/mnt/disk/services.yml',
      terminal: 'Ghostty',
    })
    const { config } = loadConfig({ path: box.configPath, home: box.home, env: {} })
    assert.deepEqual(config.roots, [{ name: 'disk', path: '/mnt/disk/projects' }])
    assert.equal(config.catalogue_path, '/mnt/disk/services.yml')
    assert.equal(config.terminal, 'Ghostty')
  })

  test('$BARDOLIER_ROOT beats the file, replaces the whole list, and is reported', () => {
    const box = sandbox()
    box.writeConfig({ roots: [{ name: 'disk', path: '/mnt/disk/projects' }] })
    const loaded = loadConfig({
      path: box.configPath,
      home: box.home,
      env: { BARDOLIER_ROOT: '/elsewhere/projects' },
    })
    assert.deepEqual(loaded.config.roots, [{ name: 'projects', path: '/elsewhere/projects' }])
    assert.deepEqual([...loaded.overrides], ['BARDOLIER_ROOT'])
  })

  test('$BDLR_SSD_VOLUME is ignored — there is no ssd_volume key left to override (phase 17)', () => {
    const box = sandbox()
    const loaded = loadConfig({ path: box.configPath, home: box.home, env: { BDLR_SSD_VOLUME: '/elsewhere' } })
    assert.deepEqual([...loaded.overrides], [])
  })

  test('expands ~ against the resolved home', () => {
    const box = sandbox()
    box.writeConfig({ roots: [{ name: 'p', path: '~/projects' }] })
    const { config } = loadConfig({ path: box.configPath, home: box.home, env: {} })
    assert.deepEqual(config.roots, [{ name: 'p', path: join(box.home, 'projects') }])
  })

  test('an empty file is equivalent to no file', () => {
    const box = sandbox()
    box.writeFile('empty.yml', '')
    const { config } = loadConfig({ path: join(box.home, '..', 'empty.yml'), home: box.home, env: {} })
    assert.deepEqual(config.roots, [{ name: 'bardolier-projects', path: join(box.home, 'bardolier-projects') }])
  })

  test('duplicate root names or paths are CONFIG_INVALID', () => {
    const box = sandbox()
    box.writeConfig({ roots: [{ name: 'a', path: '/x' }, { name: 'a', path: '/y' }] })
    assert.throws(
      () => loadConfig({ path: box.configPath, home: box.home, env: {} }),
      (error: unknown) => error instanceof BardolierError && error.code === 'CONFIG_INVALID',
    )
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
    const path = box.writeFile('bad.yml', 'roots: [unclosed\n')
    assert.throws(
      () => loadConfig({ path, home: box.home, env: {} }),
      (error: unknown) => error instanceof BardolierError && error.code === 'CONFIG_INVALID',
    )
  })

  test('the config file lives on the internal disk, not on a root', () => {
    const path = defaultConfigPath({}, '/Users/someone')
    assert.equal(path, '/Users/someone/.config/bardolier/config.yml')
  })
})

describe('containingVolume', () => {
  test('a root nested several directories deep still resolves to the mount point', () => {
    const box = sandbox()
    const nested = join(box.root, 'a', 'b', 'c', 'd')
    mkdirSync(nested, { recursive: true })
    // Depth doesn't matter — both ends of the same tree share every st_dev
    // boundary up to wherever the device actually changes.
    assert.equal(containingVolume(nested), containingVolume(box.root))
  })

  test('null when the path is not readable', () => {
    const box = sandbox()
    assert.equal(containingVolume(join(box.root, 'nope')), null)
  })
})

describe('SsdProbe (cli-spec.md §8)', () => {
  test('volume is derived from the root, and volumePresent is gone', () => {
    const box = sandbox()
    const ctx = makeContext(box, stubDocker())
    const probe = probeRoot(defaultRoot(ctx.config))
    assert.equal(probe.volume, containingVolume(box.root))
    assert.ok(!('volumePresent' in probe))
  })

  test('an unreadable root reports a null volume', () => {
    const box = sandbox()
    const ctx = makeContext(box, stubDocker(), { env: { BARDOLIER_ROOT: join(box.root, 'gone') } })
    const probe = probeRoot(defaultRoot(ctx.config))
    assert.equal(probe.mounted, false)
    assert.equal(probe.volume, null)
  })
})

describe('config (cli-spec.md §8, phase 17)', () => {
  test('ssd_volume is gone: not a settable key, not in config get', () => {
    assert.ok(!(CONFIG_KEYS as readonly string[]).includes('ssd_volume'))

    const box = sandbox()
    const output = collectConfigGet(makeContext(box, stubDocker()))
    assert.ok(!('ssd_volume' in output.config))
  })

  test('$BDLR_SSD_VOLUME is ignored and absent from overrides', () => {
    const box = sandbox()
    const loaded = loadConfig({ path: box.configPath, home: box.home, env: { BDLR_SSD_VOLUME: '/elsewhere' } })
    assert.deepEqual([...loaded.overrides], [])
  })
})

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

describe('config get (app-spec.md §12)', () => {
  test('reports the effective config and the file it came from', () => {
    const box = sandbox()
    box.writeConfig({ catalogue_path: '/Volumes/other/services.yml', terminal: 'iTerm' })

    const output = collectConfigGet(fileConfigured(box))

    assert.ok(validate('config-get', output).valid, validate('config-get', output).errors.join('\n'))
    assert.equal(output.path, box.configPath)
    assert.equal(output.exists, true)
    assert.equal(output.config.terminal, 'iTerm')
    assert.equal(output.config.catalogue_path, '/Volumes/other/services.yml')
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
    // Roots aren't part of `config get` at all (they're list-valued — `root
    // list`, phase 18); $BARDOLIER_ROOT is still reported as an override.
    assert.deepEqual(output.overrides, ['BARDOLIER_ROOT'])
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
    const output = runConfigSet(fileConfigured(box), { key: 'catalogue_path', value: '~/services.yml' })

    assert.equal(output.config.catalogue_path, `${box.home}/services.yml`)
    assert.equal(
      (parseYaml(readFileSync(box.configPath, 'utf8')) as { catalogue_path: string }).catalogue_path,
      `${box.home}/services.yml`,
    )
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
    runConfigSet(fileConfigured(first), { key: 'catalogue_path', value: '/tmp/services.yml' })

    const second = sandbox()
    runConfigSet(fileConfigured(second), { key: 'catalogue_path', value: '/tmp/services.yml' })
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

  // `roots` is list-valued and not settable through `config set` at all (see
  // `bardolier root add|remove`, phase 18) — there is no longer a settable key an
  // env override can shadow, so the old "overridden key is still written" case
  // no longer has a scenario to cover.
  test('`roots` is rejected as a `config set` key — it is list-valued (phase 18)', () => {
    const box = sandbox()
    assert.throws(
      () => runConfigSet(fileConfigured(box), { key: 'roots', value: '/x' }),
      (error: unknown) => error instanceof BardolierError && error.code === 'INVALID_ARGUMENT',
    )
  })
})
