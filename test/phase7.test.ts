/**
 * Phase 7 tests — the two flows that leave the app: the host terminal, and the
 * SSD.
 *
 * Phase 7's done-check is a human ejecting a real disk with Xcode open, which
 * no script can do. What a terminal CAN own is everything those flows depend
 * on, and both halves are here because both halves can rot:
 *
 *   - THE CLI half, run for real: an eject held by a process is EJECT_BLOCKED
 *     carrying `holders`, the disk is NOT unmounted anyway, and the same
 *     command succeeds once the holder goes — which is exactly what the menu's
 *     Retry does. `shell` resolves to argv, which is what the app hands the
 *     terminal.
 *   - THE APP half, read as text (Xcode is host-only; see app-models.test.ts
 *     for why this is a text scan): the eject flow keeps its holders on screen
 *     for a retry instead of reducing them to a banner the next refresh wipes,
 *     the app never invents a way to force an unmount, the auto-shell
 *     preference reaches `up`, and a missing `cproj` is a first-run state
 *     rather than one failed command.
 *
 * The property common to all of it: the app RENDERS the CLI's answer about the
 * disk and never second-guesses it. `lsof` said who holds the volume; the menu
 * lists them and offers to try again.
 */

import { test, describe, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import { CprojError } from '../cli/src/errors.ts'
import { validate } from '../cli/src/schema.ts'
import { runEject } from '../cli/src/commands/ssd.ts'
import { runShell } from '../cli/src/commands/shell.ts'
import { runNew } from '../cli/src/commands/new.ts'
import type { Context } from '../cli/src/context.ts'
import {
  holder,
  makeContext,
  makeSandbox,
  stubDevice,
  stubDocker,
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
  function ejectContext(box: Sandbox, docker: StubDocker, device: StubDevice): Context {
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
