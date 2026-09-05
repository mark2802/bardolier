/**
 * Phase 17 — one root, a derived volume. `ssd_volume` is gone as a config key;
 * `containingVolume` derives the mount point from `ssd_root` by walking `st_dev`
 * boundaries, so `eject` and `doctor` can never be told a volume that disagrees
 * with the root.
 */

import { test, describe, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'

import { BardolierError } from '../cli/src/errors.ts'
import { CONFIG_KEYS, loadConfig } from '../cli/src/config.ts'
import { containingVolume, probeSsd } from '../cli/src/projects.ts'
import { runEject } from '../cli/src/commands/ssd.ts'
import { collectConfigGet } from '../cli/src/commands/config.ts'
import { makeContext, makeSandbox, stubDevice, stubDocker, type Sandbox } from './helpers.ts'

const sandboxes: Sandbox[] = []
function sandbox(): Sandbox {
  const created = makeSandbox()
  sandboxes.push(created)
  return created
}
afterEach(() => {
  while (sandboxes.length > 0) sandboxes.pop()?.cleanup()
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
    const probe = probeSsd(ctx.config)
    assert.equal(probe.volume, containingVolume(box.root))
    assert.ok(!('volumePresent' in probe))
  })

  test('an unreadable root reports a null volume', () => {
    const box = sandbox()
    const ctx = makeContext(box, stubDocker(), { env: { BDLR_SSD_ROOT: join(box.root, 'gone') } })
    const probe = probeSsd(ctx.config)
    assert.equal(probe.mounted, false)
    assert.equal(probe.volume, null)
  })
})

describe('eject (cli-spec.md §6, phase 17)', () => {
  test('the volume ejected is the one derived from the root, not anything config said', async () => {
    const box = sandbox()
    const device = stubDevice([], { removable: true })
    const ctx = makeContext(box, stubDocker(), { device })

    const output = await runEject(ctx)
    const expected = containingVolume(box.root)
    assert.equal(output.volume, expected)
    assert.deepEqual(device.ejected, [expected])
  })

  test('a non-removable root fails EJECT_NOT_APPLICABLE, naming the derived volume', async () => {
    const box = sandbox()
    const device = stubDevice([], { removable: false })
    const ctx = makeContext(box, stubDocker(), { device })

    await assert.rejects(
      () => runEject(ctx),
      (error: unknown) => {
        assert.ok(error instanceof BardolierError)
        assert.equal(error.code, 'EJECT_NOT_APPLICABLE')
        assert.ok(error.message.includes(containingVolume(box.root) ?? ''))
        return true
      },
    )
  })

  test('an unreadable root is SSD_NOT_MOUNTED, naming the root', async () => {
    const box = sandbox()
    const ctx = makeContext(box, stubDocker(), { env: { BDLR_SSD_ROOT: join(box.root, 'gone') } })

    await assert.rejects(
      () => runEject(ctx),
      (error: unknown) => {
        assert.ok(error instanceof BardolierError)
        assert.equal(error.code, 'SSD_NOT_MOUNTED')
        assert.ok(error.message.includes(join(box.root, 'gone')))
        return true
      },
    )
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
