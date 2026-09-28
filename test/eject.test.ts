/**
 * down-all, eject, the holders that block it, and Docker Desktop’s VM.
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { join } from 'node:path'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import { BardolierError } from '../cli/src/errors.ts'
import { validate } from '../cli/src/schema.ts'
import {
  createSsdDevice,
  isRuntimeHolder,
  isSystemHolder,
  parseDissenter,
  parseLsof,
  type SsdDevice,
} from '../cli/src/device.ts'
import { runNew } from '../cli/src/commands/new.ts'
import { runDownAll, runEject, runEjectAll } from '../cli/src/commands/ssd.ts'
import { containingVolume } from '../cli/src/projects.ts'
import type { Context } from '../cli/src/context.ts'
import {
  finding,
  holder,
  labels,
  makeContext,
  project,
  type Sandbox,
  sandboxes,
  stubConfirm,
  stubDevice,
  type StubDevice,
  stubDocker,
  type StubDocker,
  stubWait,
  tempDirs,
} from './helpers.ts'

const sandbox = sandboxes()
const tempDir = tempDirs('bardolier-eject-all-')

const repo = (p: string) => fileURLToPath(new URL(`../${p}`, import.meta.url))

// ── down-all (§6, Lifecycle / SSD) ────────────────────────────────────────────
describe('down-all (cli-spec.md §6)', () => {
  test('stops what is running and leaves what is not alone', async () => {
    const box = sandbox()
    const docker = stubDocker({ running: ['bardolier-alpha', 'bardolier-alpha-postgres'] })
    const ctx = makeContext(box, docker)
    await project(ctx, 'alpha', { services: 'postgres' })
    await project(ctx, 'beta')

    const output = await runDownAll(ctx)
    assert.deepEqual(output.stopped, ['alpha'])
    assert.deepEqual(output.projects, [
      { name: 'alpha', was_running: true },
      { name: 'beta', was_running: false },
    ])
    assert.ok(validate('down-all', output).valid)
    assert.deepEqual(
      docker.calls.filter((call) => call.kind === 'down').length,
      1,
      'a stopped project was torn down needlessly',
    )
  })

  test('never removes volumes — down-all keeps data like down does', async () => {
    const box = sandbox()
    const docker = stubDocker({
      running: ['bardolier-alpha', 'bardolier-alpha-postgres'],
      volumes: [{ name: 'alpha_pgdata', labels: labels('alpha', 'postgres'), size_bytes: 1 }],
    })
    const ctx = makeContext(box, docker)
    await project(ctx, 'alpha', { services: 'postgres' })

    await runDownAll(ctx)
    assert.deepEqual(docker.calls.filter((call) => call.kind === 'removeVolume'), [])
    assert.deepEqual(await docker.volumeNames(), ['alpha_pgdata'])
  })

  test('sweeps a bardolier container no manifest claims', async () => {
    const box = sandbox()
    const docker = stubDocker({ running: ['bardolier-ghost', 'unrelated-container'] })
    const ctx = makeContext(box, docker)
    await project(ctx, 'alpha')

    const output = await runDownAll(ctx)
    assert.deepEqual(output.stray_containers, ['bardolier-ghost'])
    assert.deepEqual(docker.calls, [{ kind: 'removeContainer', name: 'bardolier-ghost' }])
  })

  test('an unreachable daemon is a no-op success — nothing can be running', async () => {
    const box = sandbox()
    const ctx = makeContext(box, stubDocker({ available: true }))
    await project(ctx, 'alpha')

    const output = await runDownAll(makeContext(box, stubDocker({ available: false })))
    assert.equal(output.docker_available, false)
    assert.deepEqual(output.stopped, [])
    assert.deepEqual(output.projects, [{ name: 'alpha', was_running: false }])
  })
})

// ── eject (§6, Lifecycle / SSD) ───────────────────────────────────────────────
describe('eject (cli-spec.md §6)', () => {
  /** The mount point is whatever `containingVolume` derives from `box.root` on this machine (phase 17) — not a settable value. */
  function ejectContext(box: Sandbox, docker: StubDocker, device: StubDevice): Context {
    return makeContext(box, docker, { device })
  }

  test('stops everything, finds nothing holding it, and ejects', async () => {
    const box = sandbox()
    const docker = stubDocker({ running: ['bardolier-alpha'] })
    const device = stubDevice()
    const ctx = ejectContext(box, docker, device)
    await project(ctx, 'alpha')

    const output = await runEject(ctx)
    assert.deepEqual(output.stopped, ['alpha'])
    assert.equal(output.ejected, true)
    assert.deepEqual(output.holders, [])
    assert.deepEqual(device.ejected, [containingVolume(box.root)])
    assert.ok(validate('eject', output).valid)
  })

  test('a held volume is EJECT_BLOCKED with the holders named, and is not forced', async () => {
    const box = sandbox()
    const docker = stubDocker({ running: [] })
    const device = stubDevice([holder({ pid: 431, command: 'Xcode', paths: [`${box.root}/alpha`] })])
    const ctx = ejectContext(box, docker, device)
    await project(ctx, 'alpha')

    await assert.rejects(
      () => runEject(ctx),
      (error: unknown) => {
        assert.ok(error instanceof BardolierError)
        assert.equal(error.code, 'EJECT_BLOCKED')
        const holders = error.details?.holders as { command: string; pid: number }[]
        assert.deepEqual(holders.map((h) => h.command), ['Xcode'])
        assert.match(error.message, /Xcode \[pid 431\]/)
        assert.ok(validate('error', error.toPayload()).valid)
        return true
      },
    )
    assert.deepEqual(device.ejected, [], 'a blocked eject unmounted the disk anyway')
  })

  test('the same volume ejects once the holder quits', async () => {
    const box = sandbox()
    const device = stubDevice([holder({ command: 'zsh' })])
    const ctx = ejectContext(box, stubDocker({ running: [] }), device)
    await project(ctx, 'alpha')

    await assert.rejects(() => runEject(ctx), (error: unknown) => error instanceof BardolierError)
    device.setHolders([])
    const output = await runEject(ctx)
    assert.equal(output.ejected, true)
    assert.deepEqual(device.ejected, [containingVolume(box.root)])
  })

  test('containers come down BEFORE holders are checked — they are holders too', async () => {
    const box = sandbox()
    const docker = stubDocker({ running: ['bardolier-alpha'] })
    const order: string[] = []
    const device: StubDevice = {
      ejected: [],
      setHolders() {},
      setRuntimeHolders() {},
      setRemovable() {},
      releaseRuntimeAfter() {},
      runtimeProbes: () => 0,
      async removable() {
        return true
      },
      async holders() {
        order.push('holders')
        return []
      },
      async runtimeHolders() {
        return []
      },
      async eject() {
        order.push('eject')
      },
    }
    const recording = {
      ...docker,
      async composeDown(target: Parameters<StubDocker['composeDown']>[0]) {
        order.push('down')
        await docker.composeDown(target)
      },
    }
    const ctx = makeContext(box, recording, { device })
    await project(ctx, 'alpha')

    await runEject(ctx)
    assert.deepEqual(order, ['down', 'holders', 'eject'])
  })

  test('an absent root is SSD_NOT_MOUNTED and stops nothing', async () => {
    const box = sandbox()
    const docker = stubDocker({ running: ['bardolier-alpha'] })
    const device = stubDevice()
    const ctx = makeContext(box, docker, { device, env: { BARDOLIER_ROOT: `${box.root}-gone` } })

    await assert.rejects(
      () => runEject(ctx),
      (error: unknown) => error instanceof BardolierError && error.code === 'SSD_NOT_MOUNTED',
    )
    assert.deepEqual(docker.calls, [])
    assert.deepEqual(device.ejected, [])
  })
})

// ── the host probes (§6) ──────────────────────────────────────────────────────
describe('the lsof/diskutil seam', () => {
  const LSOF = ['p431', 'cXcode', 'Lmark', 'fcwd', 'n/Volumes/ssd/claude-projects/alpha', 'p9', 'czsh', 'Lmark', 'n/Volumes/ssd'].join(
    '\n',
  )

  test('parses lsof machine output into holders', () => {
    const holders = parseLsof(LSOF, '/Volumes/ssd')
    assert.deepEqual(holders, [
      { pid: 9, command: 'zsh', user: 'mark', paths: ['/Volumes/ssd'] },
      { pid: 431, command: 'Xcode', user: 'mark', paths: ['/Volumes/ssd/claude-projects/alpha'] },
    ])
  })

  test('ignores what a process holds elsewhere', () => {
    const holders = parseLsof(['p1', 'claunchd', 'Lroot', 'n/dev/null'].join('\n'), '/Volumes/ssd')
    assert.deepEqual(holders[0]?.paths, [])
  })

  test('no match is no holders, not a failure', async () => {
    const device = createSsdDevice(async () => ({ code: 1, stdout: '', stderr: '' }))
    assert.deepEqual(await device.holders('/Volumes/ssd'), [])
  })

  test('a broken lsof refuses rather than reporting "nothing holds it"', async () => {
    const device = createSsdDevice(async () => ({ code: 127, stdout: '', stderr: 'lsof: command not found' }))
    await assert.rejects(
      () => device.holders('/Volumes/ssd'),
      (error: unknown) => error instanceof BardolierError && error.code === 'EJECT_BLOCKED',
    )
  })

  test('our own process is not a holder; the shell that launched it is', async () => {
    const device = createSsdDevice(async () => ({ code: 0, stdout: LSOF, stderr: '' }), 431)
    const holders = await device.holders('/Volumes/ssd')
    assert.deepEqual(holders.map((h) => h.pid), [9])
  })

  test('a diskutil refusal is EJECT_BLOCKED, never retried with force', async () => {
    const calls: string[][] = []
    const device = createSsdDevice(async (command, args) => {
      calls.push([command, ...args])
      return { code: 1, stdout: '', stderr: 'Unmount failed: dissenter' }
    })
    await assert.rejects(
      () => device.eject('/Volumes/ssd'),
      (error: unknown) => error instanceof BardolierError && error.code === 'EJECT_BLOCKED',
    )
    assert.deepEqual(calls, [['diskutil', 'eject', '/Volumes/ssd']])
  })
})

describe('holders the user cannot act on', () => {
  const DOCKER_LSOF = ['p23619', 'ccom.apple.Virtualization.Virtua', 'Lmark', 'n/Volumes/ssd/claude-projects/alpha'].join('\n')

  test("the container runtime's own descriptors do not block an eject", async () => {
    // Docker Desktop holds a descriptor on every bind-mounted path for as long
    // as the share exists — including after down-all. Reporting it would make
    // "quit Docker" the answer to every eject.
    const device = createSsdDevice(async () => ({ code: 0, stdout: DOCKER_LSOF, stderr: '' }))
    assert.deepEqual(await device.holders('/Volumes/ssd'), [])
    assert.equal(isRuntimeHolder('com.docker.backend'), true)
    assert.equal(isRuntimeHolder('Xcode'), false)
  })

  test('but a real user process alongside it still does', async () => {
    const stdout = `${DOCKER_LSOF}\np431\ncXcode\nLmark\nn/Volumes/ssd/claude-projects/alpha`
    const device = createSsdDevice(async () => ({ code: 0, stdout, stderr: '' }))
    assert.deepEqual((await device.holders('/Volumes/ssd')).map((h) => h.command), ['Xcode'])
  })

  // Spotlight is the one that made "Close all & eject" impossible rather than
  // merely inconvenient: `mds_stores` maps the volume's index for as long as it
  // is mounted, so counting it is a refusal with no end state.
  const SPOTLIGHT_LSOF = [
    'p343',
    'cmds',
    'Lroot',
    'n/Volumes/ssd',
    'p556',
    'cmds_stores',
    'Lroot',
    'n/Volumes/ssd/.Spotlight-V100/Store-V2/67C1D8EB/store.db',
    'p654',
    'ccom.apple.quicklook.ThumbnailsAgent',
    'Lmark',
    'n/Volumes/ssd/claude-projects/alpha/project.yml',
  ].join('\n')

  test('Spotlight and the preview agents never block an eject', async () => {
    const device = createSsdDevice(async () => ({ code: 0, stdout: SPOTLIGHT_LSOF, stderr: '' }))
    assert.deepEqual(await device.holders('/Volumes/ssd'), [])
    assert.equal(isSystemHolder('mds_stores'), true)
    assert.equal(isSystemHolder('mdworker_shared'), true)
    assert.equal(isSystemHolder('com.apple.quicklook.ThumbnailsAgent'), true)
    assert.equal(isSystemHolder('Xcode'), false)
    // An editor indexing a repo on the SSD is a real holder with a real fix.
    assert.equal(isSystemHolder('plugin_host-3.8'), false)
  })

  test('a user process is still named when the system agents are there too', async () => {
    const stdout = `${SPOTLIGHT_LSOF}\np51310\ncplugin_host-3.8\nLmark\nn/Volumes/ssd/analysta/.git/objects/10/5c57`
    const device = createSsdDevice(async () => ({ code: 0, stdout, stderr: '' }))
    assert.deepEqual((await device.holders('/Volumes/ssd')).map((h) => h.command), ['plugin_host-3.8'])
  })
})

describe('a refusal always names something (§6)', () => {
  test("diskutil's dissenter becomes a holder, in every shape it prints it", () => {
    assert.deepEqual(
      parseDissenter('Volume ssd on disk5s1 failed to eject\nDissenter PID = 51310 (plugin_host-3.8), Status = 0x0000c010'),
      [{ pid: 51310, command: 'plugin_host-3.8', user: null, paths: [] }],
    )
    assert.deepEqual(
      parseDissenter('Unmount failed for /Volumes/ssd: dissented by PID 556 (mds_stores)').map((h) => h.command),
      ['mds_stores'],
    )
  })

  test('a refusal that names no PID invents no holder', () => {
    assert.deepEqual(parseDissenter('Unmount of disk5s1 failed: at least one volume could not be unmounted'), [])
  })

  test('the blocked eject carries the dissenter lsof could not see', async () => {
    // holders() runs unprivileged, so a root dissenter is named HERE or nowhere.
    const device = createSsdDevice(async () => ({
      code: 1,
      stdout: '',
      stderr: 'Volume ssd on disk5s1 failed to eject\nDissenter PID = 556 (mds_stores), Status = 0x0000c010',
    }))
    await assert.rejects(
      () => device.eject('/Volumes/ssd'),
      (error: unknown) => {
        assert.ok(error instanceof BardolierError)
        assert.equal(error.code, 'EJECT_BLOCKED')
        const holders = error.details?.holders as { pid: number; command: string }[]
        assert.deepEqual(holders.map((h) => h.pid), [556])
        // A system agent gets the advice that fits it — there is nothing to quit.
        assert.match(error.message, /try again in a moment/)
        return true
      },
    )
  })

  test('an app that can be quit is told to quit', async () => {
    const device = createSsdDevice(async () => ({
      code: 1,
      stdout: 'Dissenter PID = 431 (Xcode), Status = 0x0000c010',
      stderr: '',
    }))
    await assert.rejects(
      () => device.eject('/Volumes/ssd'),
      (error: unknown) => error instanceof BardolierError && /Xcode \[pid 431\] — close it and try again/.test(error.message),
    )
  })
})

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
    assert.equal(await device.removable('/Users/someone/projects'), false)
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
    const ctx = makeContext(box, stubDocker(), { env: { BARDOLIER_ROOT: join(box.root, 'gone') } })

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

// ── The CLI half ─────────────────────────────────────────────────────────────
describe('the eject flow the menu drives (app-spec.md §10)', () => {
  /** The mount point is whatever `containingVolume` derives from `box.root` on this machine (phase 17) — not a settable value. */
  function ejectContext(box: Sandbox, docker: StubDocker, device: SsdDevice): Context {
    return makeContext(box, docker, { device })
  }

  test('a blocked eject hands the app holders to render, and leaves the disk mounted', async () => {
    const box = sandbox()
    const device = stubDevice([
      holder({ pid: 501, command: 'Xcode', paths: [`${box.root}/alpha`] }),
      holder({ pid: 733, command: 'Simulator', paths: [box.root] }),
    ])
    const ctx = ejectContext(box, stubDocker({ running: [] }), device)

    await assert.rejects(
      () => runEject(ctx),
      (error: unknown) => {
        assert.ok(error instanceof BardolierError)
        assert.equal(error.code, 'EJECT_BLOCKED')
        const holders = error.details?.holders as { command: string; pid: number; paths: string[] }[]
        // Everything the panel puts on screen — the app composes none of it.
        assert.deepEqual(holders.map((holder) => holder.command), ['Xcode', 'Simulator'])
        assert.ok(holders.every((holder) => typeof holder.pid === 'number'))
        assert.ok(holders.every((holder) => Array.isArray(holder.paths)))
        return true
      },
    )
    assert.deepEqual(device.ejected, [], 'the app must never be handed a disk that was force-unmounted')
  })

  test('Retry is the same call: it succeeds once the holder quits', async () => {
    const box = sandbox()
    const device = stubDevice([holder({ pid: 501, command: 'Xcode', paths: [box.root] })])
    const ctx = ejectContext(box, stubDocker({ running: [] }), device)

    await assert.rejects(() => runEject(ctx), (error: unknown) => error instanceof BardolierError)

    // The user quits Xcode and clicks Retry — no other state to reset.
    device.setHolders([])
    const output = await runEject(ctx)

    assert.equal(output.ejected, true)
    assert.ok(validate('eject', output).valid, validate('eject', output).errors.join('\n'))
    assert.deepEqual(device.ejected, [containingVolume(box.root)])
  })

  // Below: the real device, driven by a scripted `lsof`/`diskutil`. The stub
  // above answers a holder LIST; these two are about which holders count, which
  // is a decision the stub does not make.
  //
  // `removable()` reads this out of `diskutil info -plist` before any of that
  // runs (phase 10); every test below is about what happens once eject applies,
  // so their scripted `diskutil` answers this the same way for every call: yes.
  const REMOVABLE_PLIST = '<key>Ejectable</key><true/><key>Internal</key><false/>'
  function scriptedDevice(box: Sandbox, lsof: string, diskutil: { code: number; stderr: string }): SsdDevice {
    return createSsdDevice(async (command, args) => {
      if (command === 'lsof') return { code: 0, stdout: lsof, stderr: '' }
      if (args[0] === 'info') return { code: 0, stdout: REMOVABLE_PLIST, stderr: '' }
      return { code: diskutil.code, stdout: '', stderr: diskutil.stderr }
    })
  }

  const spotlightOnly = (root: string) =>
    ['p343', 'cmds', 'Lroot', `n${root}`, 'p556', 'cmds_stores', 'Lroot', `n${root}/.Spotlight-V100/Store-V2/store.db`].join('\n')

  test('a disk held only by Spotlight ejects — the case that could never succeed', async () => {
    // mds_stores maps the index for as long as the volume is mounted, so a
    // holder check that counted it made "Close all & eject" a permanent
    // refusal on any indexed SSD.
    const box = sandbox()
    const device = scriptedDevice(box, spotlightOnly(box.root), { code: 0, stderr: '' })
    const output = await runEject(ejectContext(box, stubDocker({ running: [] }), device))

    assert.equal(output.ejected, true)
    assert.deepEqual(output.holders, [])
  })

  test('but if Spotlight really does dissent, the panel gets a name for it', async () => {
    // The safety net for filtering it: the unmount is still the thing that
    // decides, and its refusal is where a root holder is named — `lsof` runs
    // unprivileged and never sees one.
    const box = sandbox()
    const device = scriptedDevice(box, spotlightOnly(box.root), {
      code: 1,
      stderr: 'Volume ssd on disk5s1 failed to eject\nDissenter PID = 556 (mds_stores), Status = 0x0000c010',
    })

    await assert.rejects(
      () => runEject(ejectContext(box, stubDocker({ running: [] }), device)),
      (error: unknown) => {
        assert.ok(error instanceof BardolierError)
        assert.equal(error.code, 'EJECT_BLOCKED')
        const holders = error.details?.holders as { command: string; pid: number; paths: string[] }[]
        assert.deepEqual(holders.map((holder) => holder.command), ['mds_stores'], 'a blocked eject with no holders is a dead end')
        return true
      },
    )
  })

  test('an editor indexing a repo on the disk is still a holder to quit', async () => {
    // The filter is for agents that hold every volume by design, not for "any
    // process the user did not expect" — Sublime's indexer is a real reason.
    const box = sandbox()
    const lsof = `${spotlightOnly(box.root)}\np51310\ncplugin_host-3.8\nLmark\nn${box.root}/analysta/.git/objects/10/5c57`
    const device = scriptedDevice(box, lsof, { code: 0, stderr: '' })

    await assert.rejects(
      () => runEject(ejectContext(box, stubDocker({ running: [] }), device)),
      (error: unknown) => {
        assert.ok(error instanceof BardolierError)
        assert.equal(error.code, 'EJECT_BLOCKED')
        assert.deepEqual((error.details?.holders as { command: string }[]).map((h) => h.command), ['plugin_host-3.8'])
        return true
      },
    )
  })

  // ── Docker's own hold on the volume ────────────────────────────────────────
  //
  // The case that made "quit Docker Desktop" the standing price of an eject:
  // the VM shares /Volumes and keeps descriptors on the SSD while it lives, so
  // every container being down is not enough. It is not an actionable holder
  // (there is no window to close) and not a system agent (no retry ever
  // succeeds), so it gets the third answer: stop the engine, with consent.

  const dockerHolder = (root: string) => holder({ pid: 900, command: 'com.docker.backend', paths: [root] })

  test('Docker’s VM is stopped, with consent, and the disk goes', async () => {
    const box = sandbox()
    const device = stubDevice([], { runtime: [dockerHolder(box.root)] })
    const docker = stubDocker({ running: [], onStopEngine: () => device.setRuntimeHolders([]) })
    const confirm = stubConfirm(true)

    const output = await runEject(makeContext(box, docker, { device, confirm }))

    assert.equal(output.ejected, true)
    assert.equal(output.docker_stopped, true, 'the app has to be able to say the engine is down')
    assert.ok(validate('eject', output).valid, validate('eject', output).errors.join('\n'))
    assert.deepEqual(device.ejected, [containingVolume(box.root)])
    assert.deepEqual(docker.calls.filter((call) => call.kind === 'stopEngine').length, 1)
    assert.match(confirm.questions[0] ?? '', /Docker/, 'the prompt names what is being stopped')
  })

  test('declining leaves a refusal that names Docker and says what to run', async () => {
    const box = sandbox()
    const device = stubDevice([], { runtime: [dockerHolder(box.root)] })
    const docker = stubDocker({ running: [], onStopEngine: () => device.setRuntimeHolders([]) })

    await assert.rejects(
      () =>
        runEject(makeContext(box, docker, {
          device,
          confirm: stubConfirm(false),
        })),
      (error: unknown) => {
        assert.ok(error instanceof BardolierError)
        assert.equal(error.code, 'EJECT_BLOCKED')
        assert.equal(error.details?.reason, 'runtime-holds-volume')
        const holders = error.details?.holders as { command: string }[]
        assert.deepEqual(holders.map((h) => h.command), ['com.docker.backend'], 'a blocked eject always names something')
        assert.match(error.message, /--stop-docker/, 'and says the one thing that clears it')
        return true
      },
    )
    assert.deepEqual(device.ejected, [], 'a declined prompt is not a quieter yes')
    assert.equal(docker.calls.some((call) => call.kind === 'stopEngine'), false)
  })

  test('--stop-docker is consent given up front — the app’s button, and any script', async () => {
    // No `confirm` override: makeContext's default throws on any prompt, which
    // is the point. The flag has to mean "do not ask", or the app (which has no
    // terminal to answer at) could never use it.
    const box = sandbox()
    const device = stubDevice([], { runtime: [dockerHolder(box.root)] })
    const docker = stubDocker({ running: [], onStopEngine: () => device.setRuntimeHolders([]) })

    const output = await runEject(
      makeContext(box, docker, { device }),
      { stopDocker: true },
    )

    assert.equal(output.docker_stopped, true)
    assert.deepEqual(device.ejected, [containingVolume(box.root)])
  })

  test('`--stop-docker` on the actual command line reaches the flag runEject reads', async () => {
    // The suite above calls runEject directly with `{ stopDocker: true }`,
    // which never exercises argv parsing. `parse()` camelCases `--stop-docker`
    // to `stopDocker`; registry.ts's `run` must read it back under that same
    // key, or a real invocation silently never sets consent (it did once —
    // the lookup used the hyphenated form and always missed).
    const { parse } = await import('../cli/src/argv.ts')
    const { COMMANDS } = await import('../cli/src/commands/registry.ts')
    const eject = COMMANDS.find((c) => c.path.join(' ') === 'eject')
    assert.ok(eject, 'eject is registered')
    const parsed = parse(['--stop-docker'], eject)
    assert.equal(parsed.flags.stopDocker, true)
  })

  test('a refusal that names nobody still names Docker, from lsof', async () => {
    // diskutil often refuses without a dissenter. The runtime's hold is only
    // visible in lsof — which is why the device still answers that question
    // even though the holder check ignores it.
    const box = sandbox()
    const device = stubDevice([], { runtime: [dockerHolder(box.root)], dissenters: [] })
    const docker = stubDocker({ running: [], onStopEngine: () => device.setRuntimeHolders([]) })
    const confirm = stubConfirm(true)

    const output = await runEject(makeContext(box, docker, { device, confirm }))

    assert.equal(output.docker_stopped, true)
    assert.match(confirm.questions[0] ?? '', /com\.docker\.backend/)
  })

  test('an Xcode dissenter is never answered by stopping Docker', async () => {
    // Docker holds the volume too — it always does — but the process that
    // refused is one the user can close, and closing it is the right advice.
    const box = sandbox()
    const device = stubDevice([], {
      runtime: [dockerHolder(box.root)],
      dissenters: [holder({ pid: 501, command: 'Xcode', paths: [box.root] })],
    })
    const docker = stubDocker({ running: [], onStopEngine: () => device.setRuntimeHolders([]) })

    await assert.rejects(
      () =>
        runEject(makeContext(box, docker, { device, confirm: stubConfirm(true) })),
      (error: unknown) => {
        assert.ok(error instanceof BardolierError)
        assert.deepEqual((error.details?.holders as { command: string }[]).map((h) => h.command), ['Xcode'])
        return true
      },
    )
    assert.equal(docker.calls.some((call) => call.kind === 'stopEngine'), false, 'the engine is not collateral')
  })

  test('nor is a Spotlight dissenter — that one really is "try again in a moment"', async () => {
    const box = sandbox()
    const device = stubDevice([], {
      runtime: [dockerHolder(box.root)],
      dissenters: [holder({ pid: 556, command: 'mds_stores', user: 'root', paths: [box.root] })],
    })
    const docker = stubDocker({ running: [], onStopEngine: () => device.setRuntimeHolders([]) })

    await assert.rejects(
      () =>
        runEject(makeContext(box, docker, { device, confirm: stubConfirm(true) })),
      (error: unknown) => {
        assert.ok(error instanceof BardolierError)
        assert.deepEqual((error.details?.holders as { command: string }[]).map((h) => h.command), ['mds_stores'])
        return true
      },
    )
    assert.equal(docker.calls.some((call) => call.kind === 'stopEngine'), false)
  })

  test('an engine that will not stop is a refusal that says so', async () => {
    // Docker Engine without Desktop has no `docker desktop stop` to run. That
    // is a dead end for the automatic path, so the user gets the manual one.
    const box = sandbox()
    const device = stubDevice([], { runtime: [dockerHolder(box.root)] })
    const docker = stubDocker({
      running: [],
      onStopEngine: () => {
        throw new BardolierError('DOCKER_UNAVAILABLE', "Could not stop the Docker engine: unknown command 'desktop'.")
      },
    })

    await assert.rejects(
      () => runEject(makeContext(box, docker, { device }), { stopDocker: true }),
      (error: unknown) => {
        assert.ok(error instanceof BardolierError)
        assert.equal(error.code, 'EJECT_BLOCKED')
        assert.match(error.message, /Quit Docker Desktop/)
        return true
      },
    )
    assert.deepEqual(device.ejected, [])
  })

  test('end to end on the real device: a Docker dissent, then an eject', async () => {
    // The whole path with nothing stubbed but the two host commands: lsof sees
    // only Docker (so the holder check passes), diskutil dissents naming it,
    // the engine stops, and the second attempt goes through.
    const box = sandbox()
    let vmAlive = true
    const lsof = ['p900', 'ccom.docker.backend', 'Lmark', `n${box.root}/alpha`].join('\n')
    const device = createSsdDevice(async (command, args) => {
      if (command === 'lsof') return { code: 0, stdout: vmAlive ? lsof : '', stderr: '' }
      if (args[0] === 'info') return { code: 0, stdout: REMOVABLE_PLIST, stderr: '' }
      return vmAlive
        ? {
            code: 1,
            stdout: '',
            stderr: 'Volume ssd on disk5s1 failed to eject\nDissenter PID = 900 (com.docker.backend), Status = 0x0000c010',
          }
        : { code: 0, stdout: '', stderr: '' }
    })
    const docker = stubDocker({ running: [], onStopEngine: () => { vmAlive = false } })

    const output = await runEject(
      makeContext(box, docker, { device, confirm: stubConfirm(true) }),
    )

    assert.equal(output.ejected, true)
    assert.equal(output.docker_stopped, true)
  })

  test('the dissenter macOS really prints is a PATH, and it is still Docker', async () => {
    // The regression that made "Close all & eject" a dead end on a real Mac.
    // `lsof` calls the VM `com.apple.Virtualization.Virtua` — 31 characters of
    // it — so the holder check passes and the unmount is attempted; Sequoia's
    // `diskutil` then names the SAME process by its full executable path, which
    // matched none of the runtime prefixes and so read as an app to go and
    // close. There is no window to close, and the one move that works — stop
    // the engine — was never offered.
    const box = sandbox()
    const vmPath =
      '/System/Library/Frameworks/Virtualization.framework/Versions/A/XPCServices' +
      '/com.apple.Virtualization.VirtualMachine.xpc/Contents/MacOS/com.apple.Virtualization.VirtualMachine'
    const dissent = [
      'Unmount of disk5 failed: at least one volume could not be unmounted',
      `Unmount was dissented by PID 74033 (${vmPath})`,
      'Dissenter parent PPID 1 (/sbin/launchd)',
    ].join('\n')
    let vmAlive = true
    let unmounted = false
    const lsof = ['p74033', 'ccom.apple.Virtualization.Virtua', 'Lmark', `n${box.root}`].join('\n')
    const device = createSsdDevice(async (command, args) => {
      if (command === 'lsof') return { code: 0, stdout: vmAlive ? lsof : '', stderr: '' }
      if (args[0] === 'info') return { code: 0, stdout: REMOVABLE_PLIST, stderr: '' }
      if (vmAlive) return { code: 1, stdout: '', stderr: dissent }
      unmounted = true
      return { code: 0, stdout: '', stderr: '' }
    })
    const docker = stubDocker({ running: [], onStopEngine: () => { vmAlive = false } })

    // Declined — the state the app renders as "Stop Docker & eject".
    await assert.rejects(
      () =>
        runEject(makeContext(box, docker, {
          device,
          confirm: stubConfirm(false),
        })),
      (error: unknown) => {
        assert.ok(error instanceof BardolierError)
        assert.equal(error.details?.reason, 'runtime-holds-volume', 'this is the refusal the app can clear itself')
        const holders = error.details?.holders as { command: string; pid: number }[]
        assert.deepEqual(
          holders.map((h) => h.command),
          ['com.apple.Virtualization.VirtualMachine'],
          'the panel shows a process name, not 150 characters of framework path',
        )
        assert.equal(holders.length, 1, 'the PPID line is a parent, not a second holder')
        return true
      },
    )
    assert.equal(unmounted, false, 'and the disk is still mounted')
    assert.equal(docker.calls.some((call) => call.kind === 'stopEngine'), false, 'a declined prompt is not a quieter yes')

    // Consenting — the button.
    const output = await runEject(
      makeContext(box, docker, { device }),
      { stopDocker: true },
    )
    assert.equal(output.ejected, true)
    assert.equal(output.docker_stopped, true)
    assert.equal(unmounted, true)
  })

  test('the retry waits for the VM to let go instead of racing it', async () => {
    // The bug this whole path was built for, still losing on a real Mac.
    // `docker desktop stop` returns when the ENGINE reports itself down; the
    // helper that actually holds `/Volumes` is torn down after that and takes
    // seconds about it. Retrying at once lost that race every time, so the
    // answer was still "quit Docker Desktop" — which only ever worked because
    // finding the menu item takes longer than the teardown.
    const box = sandbox()
    const device = stubDevice([], { runtime: [dockerHolder(box.root)] })
    const docker = stubDocker({ running: [], onStopEngine: () => device.releaseRuntimeAfter(3) })
    const wait = stubWait()

    const output = await runEject(
      makeContext(box, docker, { device, wait }),
      { stopDocker: true },
    )

    assert.equal(output.ejected, true)
    assert.equal(output.docker_stopped, true)
    assert.deepEqual(device.ejected, [containingVolume(box.root)])
    assert.deepEqual(wait.delays, [500, 500], 'it waited for the hold to go — and stopped waiting when it went')
    assert.equal(device.runtimeProbes(), 3, 'the signal is lsof, not a fixed sleep')
  })

  test('a VM that never lets go is a refusal, not a hang — and not the advice it just took', async () => {
    // No `onStopEngine`: the engine stops and the hold survives it. The old
    // code's answer here was diskutil's refusal with `--stop-docker` appended,
    // which is the flag the user had just used.
    const box = sandbox()
    const device = stubDevice([], { runtime: [dockerHolder(box.root)] })
    const docker = stubDocker({ running: [] })
    const wait = stubWait()

    await assert.rejects(
      () =>
        runEject(makeContext(box, docker, { device, wait }), {
          stopDocker: true,
        }),
      (error: unknown) => {
        assert.ok(error instanceof BardolierError)
        assert.equal(error.code, 'EJECT_BLOCKED')
        assert.equal(error.details?.reason, 'runtime-holds-volume-after-stop')
        assert.deepEqual(
          (error.details?.holders as { command: string }[]).map((h) => h.command),
          ['com.docker.backend'],
          'a blocked eject always names something',
        )
        assert.doesNotMatch(error.message, /--stop-docker/, 'never advise the thing that just happened')
        assert.match(error.message, /already down/)
        return true
      },
    )
    assert.deepEqual(device.ejected, [])
    assert.equal(docker.calls.filter((call) => call.kind === 'stopEngine').length, 1, 'stopped once, not per attempt')
    assert.deepEqual(
      [wait.delays.filter((ms) => ms === 500).length, wait.delays.filter((ms) => ms === 1_000).length],
      [30, 2],
      'the budget is bounded: a stuck VM ends in a refusal, not a command that never returns',
    )
  })

  test('once Docker has let go, a refusal is diskutil’s to explain', async () => {
    // The disk still will not go, but lsof says the runtime is gone: something
    // else took it while we waited. Blaming Docker for that would be a guess,
    // so the refusal goes back as it came.
    const box = sandbox()
    const device = stubDevice([], { runtime: [dockerHolder(box.root)] })
    const docker = stubDocker({
      running: [],
      onStopEngine: () => {
        device.setRuntimeHolders([])
        device.setHolders([holder({ pid: 501, command: 'Xcode', paths: [box.root] })])
      },
    })

    await assert.rejects(
      () => runEject(makeContext(box, docker, { device }), { stopDocker: true }),
      (error: unknown) => {
        assert.ok(error instanceof BardolierError)
        assert.equal(error.code, 'EJECT_BLOCKED')
        assert.notEqual(error.details?.reason, 'runtime-holds-volume-after-stop')
        assert.doesNotMatch(error.message, /Docker/, 'the runtime is not what refused this time')
        return true
      },
    )
    assert.deepEqual(device.ejected, [])
  })

  test('there is no way to force an unmount, so the menu cannot offer one', () => {
    const source = readFileSync(repo('cli/src/commands/ssd.ts'), 'utf8')
    assert.doesNotMatch(source, /'--force'|"--force"/, 'eject must not grow a force flag for the app to reach for')
  })
})

// ── eject --all (cli-spec.md §6, phase 22) ────────────────────────────────────
describe('eject --all (cli-spec.md §6, phase 22)', () => {
  test('zero removable roots is EJECT_NOT_APPLICABLE, before anything is stopped', async () => {
    const box = sandbox()
    const docker = stubDocker({ running: ['bardolier-alpha'] })
    const device = stubDevice([], { removable: false })
    const ctx = makeContext(box, docker, { device })
    await project(ctx, 'alpha')

    await assert.rejects(
      () => runEjectAll(ctx),
      (error: unknown) => {
        assert.ok(error instanceof BardolierError)
        assert.equal(error.code, 'EJECT_NOT_APPLICABLE')
        return true
      },
    )
    assert.deepEqual(docker.calls.filter((call) => call.kind === 'down'), [], 'down-all must not run when nothing qualifies')
  })

  test('every candidate clean: both roots eject, in configured order', async () => {
    const box = sandbox()
    const rootB = tempDir()
    box.writeConfig({ roots: [{ name: 'a', path: box.root }, { name: 'b', path: rootB }] })
    const device = stubDevice([], { removable: true })
    const ctx = makeContext(box, stubDocker(), { env: { BARDOLIER_ROOT: '' }, device })

    const output = await runEjectAll(ctx)
    assert.deepEqual(output.results.map((r) => r.root), ['a', 'b'])
    assert.ok(output.results.every((r) => r.ejected === true && r.holders.length === 0))
    assert.equal(device.ejected.length, 2)
    assert.ok(validate('eject-all', output).valid)
  })

  test('one root blocked does not stop the other from being attempted (best-effort)', async () => {
    const box = sandbox()
    const rootB = tempDir()
    box.writeConfig({ roots: [{ name: 'a', path: box.root }, { name: 'b', path: rootB }] })

    // `containingVolume` resolves both temp dirs to the same real volume
    // (disk-done-check.sh notes the same fiction), so the blocked disk is told
    // apart by CALL ORDER — `runEjectAll` visits candidates in configured
    // order (a, then b) — rather than by which mount string it was asked about.
    let holderCalls = 0
    const ejected: string[] = []
    const device: SsdDevice = {
      async removable() {
        return true
      },
      async holders() {
        holderCalls += 1
        return holderCalls === 1 ? [holder({ pid: 501, command: 'Xcode' })] : []
      },
      async runtimeHolders() {
        return []
      },
      async eject(mountPoint) {
        ejected.push(mountPoint)
      },
    }
    const ctx = makeContext(box, stubDocker(), { env: { BARDOLIER_ROOT: '' }, device })

    const output = await runEjectAll(ctx)
    assert.equal(output.results.length, 2)
    assert.equal(output.results[0]?.root, 'a')
    assert.equal(output.results[0]?.ejected, false)
    assert.equal(output.results[0]?.holders[0]?.command, 'Xcode')
    assert.equal(output.results[1]?.root, 'b')
    assert.equal(output.results[1]?.ejected, true)
    assert.deepEqual(ejected, [output.results[1]?.volume])
    assert.ok(validate('eject-all', output).valid, 'a mixed batch still validates as one payload')
  })
})
