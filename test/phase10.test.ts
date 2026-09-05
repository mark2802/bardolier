/**
 * Phase 10 — a local root (no SSD required). `ssd_root` pointed at an ordinary
 * directory has always worked for the project lifecycle; this phase is about
 * the two places that assumed a removable volume — `eject` and `doctor` — now
 * giving honest answers instead of SSD-shaped ones.
 */

import { test, describe, afterEach } from 'node:test'
import assert from 'node:assert/strict'

import { BardolierError } from '../cli/src/errors.ts'
import { validate } from '../cli/src/schema.ts'
import { createSsdDevice } from '../cli/src/device.ts'
import { runEject } from '../cli/src/commands/ssd.ts'
import { collectDoctor } from '../cli/src/commands/doctor.ts'
import { runNew } from '../cli/src/commands/new.ts'
import type { Context } from '../cli/src/context.ts'
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

function finding(report: Awaited<ReturnType<typeof collectDoctor>>, id: string) {
  const found = report.findings.find((f) => f.id === id)
  assert.ok(found, `doctor produced no \`${id}\` finding`)
  return found
}

// ── SsdDevice.removable() ────────────────────────────────────────────────────

describe('removable() (cli-spec.md §6)', () => {
  test('a removable, non-internal volume is removable', async () => {
    const device = createSsdDevice(async () => ({
      code: 0,
      stdout: '<key>Ejectable</key><true/><key>Internal</key><false/>',
      stderr: '',
    }))
    assert.equal(await device.removable('/Volumes/ssd'), true)
  })

  test('an internal directory is not removable, even if diskutil answers', async () => {
    const device = createSsdDevice(async () => ({
      code: 0,
      stdout: '<key>Ejectable</key><false/><key>Internal</key><true/>',
      stderr: '',
    }))
    assert.equal(await device.removable('/Users/mark/projects'), false)
  })

  test('a probe failure is not removable, never a throw', async () => {
    const device = createSsdDevice(async () => ({ code: 1, stdout: '', stderr: 'No such file or directory' }))
    assert.equal(await device.removable('/nonexistent'), false)
  })

  test('a plist with neither key present is not removable', async () => {
    const device = createSsdDevice(async () => ({ code: 0, stdout: '<dict/>', stderr: '' }))
    assert.equal(await device.removable('/'), false)
  })
})

// ── eject ────────────────────────────────────────────────────────────────────

describe('eject on a non-removable root (cli-spec.md §6)', () => {
  function ejectContext(box: Sandbox, running: readonly string[], removable: boolean): { ctx: Context; docker: ReturnType<typeof stubDocker> } {
    const docker = stubDocker({ running: [...running] })
    const device = stubDevice([], { removable })
    const ctx = makeContext(box, docker, { device })
    return { ctx, docker }
  }

  test('a non-removable ssd_volume fails EJECT_NOT_APPLICABLE, and stops nothing on the way', async () => {
    const box = sandbox()
    const { ctx, docker } = ejectContext(box, ['bardolier-alpha'], false)
    await runNew(ctx, { name: 'alpha', archetype: 'web', services: undefined })

    await assert.rejects(
      () => runEject(ctx),
      (error: unknown) => {
        assert.ok(error instanceof BardolierError)
        assert.equal(error.code, 'EJECT_NOT_APPLICABLE')
        assert.match(error.message, /down-all/)
        assert.ok(validate('error', error.toPayload()).valid)
        return true
      },
    )
    // down-all never ran: the container that was "up" is still there.
    assert.ok(docker.calls.every((call) => call.kind !== 'down'))
  })

  test('a removable volume is unaffected — the existing eject flow still runs', async () => {
    const box = sandbox()
    const { ctx } = ejectContext(box, [], true)
    const output = await runEject(ctx)
    assert.equal(output.ejected, true)
  })
})

// ── doctor ───────────────────────────────────────────────────────────────────

describe('doctor on a local root (cli-spec.md §6)', () => {
  test('a non-removable root is ok, with no "plug in" remedy', async () => {
    const box = sandbox()
    const device = stubDevice([], { removable: false })
    const ctx = makeContext(box, stubDocker(), { device })

    const report = await collectDoctor(ctx)
    const ssd = finding(report, 'ssd')
    assert.equal(ssd.ok, true)
    assert.equal(ssd.remedy, undefined)
    assert.doesNotMatch(ssd.detail, /[Pp]lug in/)
    assert.match(ssd.detail, /eject/)
    assert.equal(ssd.roots?.[0]?.removable, false, 'structured per-root state, for the app to tell SSD wording apart from internal-disk wording')
    assert.ok(validate('doctor', report).valid)
  })

  test('a removable root keeps the original wording', async () => {
    const box = sandbox()
    const device = stubDevice([], { removable: true })
    const ctx = makeContext(box, stubDocker(), { device })

    const report = await collectDoctor(ctx)
    const ssd = finding(report, 'ssd')
    assert.match(ssd.detail, /readable \(volume/)
    assert.equal(ssd.roots?.[0]?.removable, true)
  })

  test('an unreadable root reports removable: null — nothing to ask diskutil about', async () => {
    const box = sandbox()
    const ctx = makeContext(box, stubDocker(), { env: { BARDOLIER_ROOT: '/nonexistent/nowhere' } })

    const report = await collectDoctor(ctx)
    const ssd = finding(report, 'ssd')
    assert.equal(ssd.roots?.[0]?.mounted, false)
    assert.equal(ssd.roots?.[0]?.removable, null)
  })
})
