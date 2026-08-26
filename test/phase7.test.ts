/**
 * Phase 7 — the two flows that leave the app: the host terminal and the SSD.
 *   - THE CLI half, run for real: a held eject is EJECT_BLOCKED carrying
 *     `holders`, the disk is NOT unmounted anyway, and the same command
 *     succeeds once the holder goes — exactly what the menu's Retry does.
 *     `shell` resolves to argv, which is what the app hands the terminal.
 *   - THE APP half, read as text (Xcode is host-only; see app-models.test.ts):
 *     the eject flow keeps its holders on screen for a retry instead of a
 *     banner the next refresh wipes, nothing invents a way to force an unmount,
 *     the auto-shell preference reaches `up`, and a missing `cproj` is a
 *     first-run state rather than one failed command.
 * Common property: the app RENDERS the CLI's answer about the disk and never
 * second-guesses it.
 */

import { test, describe, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import { CprojError } from '../cli/src/errors.ts'
import { createSsdDevice, type SsdDevice } from '../cli/src/device.ts'
import { validate } from '../cli/src/schema.ts'
import { runEject } from '../cli/src/commands/ssd.ts'
import { runShell } from '../cli/src/commands/shell.ts'
import { runNew } from '../cli/src/commands/new.ts'
import type { Context } from '../cli/src/context.ts'
import {
  holder,
  makeContext,
  makeSandbox,
  stubConfirm,
  stubDevice,
  stubDocker,
  stubWait,
  type Sandbox,
  type StubDevice,
  type StubDocker,
} from './helpers.ts'

const repo = (p: string) => fileURLToPath(new URL(`../${p}`, import.meta.url))
const APP_DIR = 'app/claude-yard/claude-yard'

const sandboxes: Sandbox[] = []
function sandbox(): Sandbox {
  const created = makeSandbox()
  sandboxes.push(created)
  return created
}
afterEach(() => {
  while (sandboxes.length > 0) sandboxes.pop()?.cleanup()
})

// ── The CLI half ─────────────────────────────────────────────────────────────

describe('the eject flow the menu drives (app-spec.md §10)', () => {
  /** A sandbox whose SSD_VOLUME is the temp dir standing in for the mount. */
  function ejectContext(box: Sandbox, docker: StubDocker, device: SsdDevice): Context {
    return makeContext(box, docker, { device, env: { CPROJ_SSD_VOLUME: box.root } })
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
        assert.ok(error instanceof CprojError)
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

    await assert.rejects(() => runEject(ctx), (error: unknown) => error instanceof CprojError)

    // The user quits Xcode and clicks Retry — no other state to reset.
    device.setHolders([])
    const output = await runEject(ctx)

    assert.equal(output.ejected, true)
    assert.ok(validate('eject', output).valid, validate('eject', output).errors.join('\n'))
    assert.deepEqual(device.ejected, [box.root])
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
        assert.ok(error instanceof CprojError)
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
        assert.ok(error instanceof CprojError)
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

    const output = await runEject(makeContext(box, docker, { device, confirm, env: { CPROJ_SSD_VOLUME: box.root } }))

    assert.equal(output.ejected, true)
    assert.equal(output.docker_stopped, true, 'the app has to be able to say the engine is down')
    assert.ok(validate('eject', output).valid, validate('eject', output).errors.join('\n'))
    assert.deepEqual(device.ejected, [box.root])
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
          env: { CPROJ_SSD_VOLUME: box.root },
        })),
      (error: unknown) => {
        assert.ok(error instanceof CprojError)
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
      makeContext(box, docker, { device, env: { CPROJ_SSD_VOLUME: box.root } }),
      { stopDocker: true },
    )

    assert.equal(output.docker_stopped, true)
    assert.deepEqual(device.ejected, [box.root])
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

    const output = await runEject(makeContext(box, docker, { device, confirm, env: { CPROJ_SSD_VOLUME: box.root } }))

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
        runEject(makeContext(box, docker, { device, confirm: stubConfirm(true), env: { CPROJ_SSD_VOLUME: box.root } })),
      (error: unknown) => {
        assert.ok(error instanceof CprojError)
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
        runEject(makeContext(box, docker, { device, confirm: stubConfirm(true), env: { CPROJ_SSD_VOLUME: box.root } })),
      (error: unknown) => {
        assert.ok(error instanceof CprojError)
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
        throw new CprojError('DOCKER_UNAVAILABLE', "Could not stop the Docker engine: unknown command 'desktop'.")
      },
    })

    await assert.rejects(
      () => runEject(makeContext(box, docker, { device, env: { CPROJ_SSD_VOLUME: box.root } }), { stopDocker: true }),
      (error: unknown) => {
        assert.ok(error instanceof CprojError)
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
      makeContext(box, docker, { device, confirm: stubConfirm(true), env: { CPROJ_SSD_VOLUME: box.root } }),
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
          env: { CPROJ_SSD_VOLUME: box.root },
        })),
      (error: unknown) => {
        assert.ok(error instanceof CprojError)
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
      makeContext(box, docker, { device, env: { CPROJ_SSD_VOLUME: box.root } }),
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
      makeContext(box, docker, { device, wait, env: { CPROJ_SSD_VOLUME: box.root } }),
      { stopDocker: true },
    )

    assert.equal(output.ejected, true)
    assert.equal(output.docker_stopped, true)
    assert.deepEqual(device.ejected, [box.root])
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
        runEject(makeContext(box, docker, { device, wait, env: { CPROJ_SSD_VOLUME: box.root } }), {
          stopDocker: true,
        }),
      (error: unknown) => {
        assert.ok(error instanceof CprojError)
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
      () => runEject(makeContext(box, docker, { device, env: { CPROJ_SSD_VOLUME: box.root } }), { stopDocker: true }),
      (error: unknown) => {
        assert.ok(error instanceof CprojError)
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

describe('shell-open (app-spec.md §7)', () => {
  test('the CLI resolves argv and spawns nothing; the app runs it', async () => {
    const box = sandbox()
    const ctx = makeContext(box, stubDocker({ running: ['cproj-alpha'] }))
    await runNew(ctx, { name: 'alpha', archetype: 'web', services: undefined })

    const invocation = await runShell(ctx, 'alpha')

    assert.ok(validate('shell', invocation).valid, validate('shell', invocation).errors.join('\n'))
    assert.equal(invocation.exec[0], 'docker')
    assert.ok(invocation.exec.length > 1, 'argv, so the app needs no quoting rules of its own')
  })
})

// ── The app half (read as text — Xcode is host-only) ─────────────────────────

describe('the app renders the eject flow rather than re-deciding it', () => {
  const store = readFileSync(repo(`${APP_DIR}/CprojStore.swift`), 'utf8')
  const panel = readFileSync(repo(`${APP_DIR}/Views/EjectPanel.swift`), 'utf8')

  test('a blocked eject is a state that survives, not a banner (§10)', () => {
    // The holder list has to outlive the refresh that follows the failed call:
    // the user goes away, quits Xcode, and comes back to it.
    assert.match(store, /case blocked\(holders: \[SsdHolder\], message: String\)/)
    assert.match(store, /ejectPhase = \.blocked\(/)
    assert.match(store, /failure\.code == \.ejectBlocked/)
  })

  test('Retry re-runs the same command (§10.2)', () => {
    assert.match(panel, /"Retry"/)
    const retries = panel.match(/await store\.closeAllAndEject\(\)/g) ?? []
    assert.ok(retries.length >= 2, 'the panel starts the eject and retries it with the same call')
  })

  test('the ejected state is reported, and cleared by the disk coming back (§11)', () => {
    assert.match(store, /case ejected\(volume: String, stopped: \[String\]\)/)
    assert.match(store, /if fresh\.ssd\.mounted \{/)
    assert.match(store, /ejected = false/)
  })

  test('a refresh does not wipe the holder list it was blocked by', () => {
    // "Blocked" means the disk is still mounted, so clearing the phase on
    // `mounted` would lose it on the next menu open — the one right after the
    // user goes and quits Xcode.
    assert.match(store, /if ejectPhase\.isEjected \{ ejectPhase = \.ready \}/)
  })

  test('nothing in the app forces an unmount or kills a holder', () => {
    const sources = readdirSync(repo(APP_DIR), { recursive: true, encoding: 'utf8' })
      .filter((entry) => entry.endsWith('.swift'))
      .map((entry) => [entry, readFileSync(repo(`${APP_DIR}/${entry}`), 'utf8')] as const)
    for (const [file, source] of sources) {
      const code = source
        .split('\n')
        .filter((line) => !line.trim().startsWith('//'))
        .join('\n')
      assert.doesNotMatch(code, /\bkill\(|SIGKILL|terminate\(withPid|diskutil/, `${file} tries to force the disk free`)
    }
  })

  test('Docker holding the disk is its own state, with its own move (§10)', () => {
    // Reduced to `.blocked` it would read "quit them, then Retry" — advice for
    // a process with a window, about one that has none and that no retry
    // clears. The distinction comes from the CLI's own `details.reason`; the
    // app does not sniff holder names to work it out.
    const error = readFileSync(repo(`${APP_DIR}/Cproj/CprojError.swift`), 'utf8')
    assert.match(error, /reason == "runtime-holds-volume"/)
    assert.match(store, /case blockedByDocker\(holders: \[SsdHolder\], message: String, engineStopped: Bool\)/)
    assert.match(store, /failure\.isRuntimeHold/)
    assert.match(panel, /"Stop Docker & eject"/)
    assert.match(panel, /closeAllAndEject\(stopDocker: true\)/)
  })

  test('and once the engine IS stopped, that button is not offered again (§10)', () => {
    // The CLI stops the engine, waits for the VM to let go, and is refused
    // anyway: `reason` says so, and the panel must not answer it with the
    // button whose whole effect has already happened.
    const error = readFileSync(repo(`${APP_DIR}/Cproj/CprojError.swift`), 'utf8')
    assert.match(error, /reason == "runtime-holds-volume-after-stop"/)
    assert.match(store, /isRuntimeHoldAfterStop/)
    assert.match(store, /engineStopped: failure\.isRuntimeHoldAfterStop/)
    // The offer lives in the `else` branch of `engineStopped`, and the message
    // the CLI wrote is what is rendered instead.
    const offer = panel.indexOf('"Stop Docker & eject"')
    const buttons = panel.lastIndexOf('HStack(spacing: 8)', offer)
    const guardAt = panel.lastIndexOf('if engineStopped {', offer)
    assert.ok(offer > 0 && buttons < guardAt && guardAt < offer, 'the offer sits behind the engineStopped guard')
  })

  test('stopping the engine is consented to here, never assumed', () => {
    // The default has to stay "don't", or the menu's ordinary eject would take
    // down every container on the Mac — cproj's and everyone else's.
    const client = readFileSync(repo(`${APP_DIR}/Cproj/CprojClient.swift`), 'utf8')
    assert.match(client, /func eject\(stopDocker: Bool = false\)/)
    assert.match(client, /stopDocker \? \["--stop-docker"\] : \[\]/)
    assert.match(store, /func closeAllAndEject\(stopDocker: Bool = false\)/)
  })

  test('the holders are shown by name, from the CLI’s own fields', () => {
    const chrome = readFileSync(repo(`${APP_DIR}/Views/MenuChrome.swift`), 'utf8')
    assert.match(chrome, /struct HolderList/)
    assert.match(chrome, /holder\.command/)
    assert.match(chrome, /holder\.pid/)
  })
})

describe('the auto-shell preference reaches the CLI (app-spec.md §7, §12)', () => {
  const preferences = readFileSync(repo(`${APP_DIR}/Preferences/AppPreferences.swift`), 'utf8')
  const menu = readFileSync(repo(`${APP_DIR}/Views/MenuBarRootView.swift`), 'utf8')
  const client = readFileSync(repo(`${APP_DIR}/Cproj/CprojClient.swift`), 'utf8')

  test('it defaults ON, and an unset key does not silently invert it', () => {
    assert.match(preferences, /object\(forKey: Self\.startOpensShellKey\) as\? Bool \?\? true/)
  })

  test('Start passes it to `up`, and says which Start it is', () => {
    assert.match(menu, /openShell: preferences\.startOpensShell/)
    assert.match(menu, /startOpensShell \? "Start & open shell" : "Start"/)
    assert.match(client, /openShell/)
  })

  test('a terminal that will not open is its own failure, with its own fix', () => {
    const error = readFileSync(repo(`${APP_DIR}/Cproj/CprojError.swift`), 'utf8')
    assert.match(error, /case terminalFailed\(terminal: String, underlying: String\)/)
    assert.match(error, /Pick a different terminal in Preferences/)
  })
})

describe('a missing cproj is a first-run state (app-spec.md §13)', () => {
  const store = readFileSync(repo(`${APP_DIR}/CprojStore.swift`), 'utf8')
  const panel = readFileSync(repo(`${APP_DIR}/Views/FirstRunPanel.swift`), 'utf8')
  const menu = readFileSync(repo(`${APP_DIR}/Views/MenuBarRootView.swift`), 'utf8')

  test('the store records it instead of reporting one failed command', () => {
    assert.match(store, /cprojMissing = true/)
    assert.match(store, /cprojSearchedLocations = CprojExecutable\.searchedLocations/)
  })

  test('the menu shows the message in place of items that cannot work', () => {
    assert.match(menu, /if store\.cprojMissing \{[\s\S]*?FirstRunPanel\(\)/)
  })

  test('it names an expected install location and the places actually searched', () => {
    assert.match(panel, /npm link/)
    assert.match(panel, /bin\/cproj/)
    assert.match(panel, /store\.cprojSearchedLocations/)
  })
})

describe('click-to-copy stays reachable (app-spec.md §5, §6)', () => {
  const chrome = readFileSync(repo(`${APP_DIR}/Views/MenuChrome.swift`), 'utf8')
  const menu = readFileSync(repo(`${APP_DIR}/Views/MenuBarRootView.swift`), 'utf8')
  const services = readFileSync(repo(`${APP_DIR}/Views/ServicesPanel.swift`), 'utf8')

  test('the whole service row copies, not a 10pt icon', () => {
    assert.match(chrome, /struct CopyRow/)
    assert.match(menu, /CopyRow\(value: service\.connectionHint/)
  })

  test('copying is not disabled along with the row it sits next to', () => {
    // The copy control must be OUTSIDE MenuRow's label: inside, it inherits
    // the row's `disabled` — and the row is disabled exactly when the project
    // is RUNNING, which is when the connection string is wanted.
    const row = services.slice(services.indexOf('private func row(for service'))
    const copyIndex = row.indexOf('CopyButton(')
    const menuRowIndex = row.indexOf('MenuRow(')
    assert.ok(copyIndex > menuRowIndex, 'the copy button follows the row rather than nesting in it')
    assert.match(row.slice(0, copyIndex), /^\s*\}\s*$/m)
  })

  test('what is copied is the CLI’s connection_hint, never a string built here', () => {
    for (const source of [menu, services]) {
      assert.doesNotMatch(source, /localhost:/)
      assert.match(source, /connectionHint/)
    }
  })
})
