/**
 * The Swift client, read as text: it renders the CLI’s answers and never re-decides them.
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import { BardolierError } from '../cli/src/errors.ts'
import { holder, project } from './helpers.ts'

const repo = (p: string) => fileURLToPath(new URL(`../${p}`, import.meta.url))

const APP_DIR = 'app/bardolier/bardolier'

// ── The app half (read as text — Xcode is host-only) ─────────────────────────
describe('the app renders the eject flow rather than re-deciding it', () => {
  const store = readFileSync(repo(`${APP_DIR}/BardolierStore.swift`), 'utf8')
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
    const retries = panel.match(/await store\.closeAllAndEject\(root: root\)/g) ?? []
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
    const error = readFileSync(repo(`${APP_DIR}/Bardolier/BardolierError.swift`), 'utf8')
    assert.match(error, /reason == "runtime-holds-volume"/)
    assert.match(store, /case blockedByDocker\(holders: \[SsdHolder\], message: String, engineStopped: Bool\)/)
    assert.match(store, /failure\.isRuntimeHold/)
    assert.match(panel, /"Stop Docker & eject"/)
    assert.match(panel, /closeAllAndEject\(root: root, stopDocker: true\)/)
  })

  test('and once the engine IS stopped, that button is not offered again (§10)', () => {
    // The CLI stops the engine, waits for the VM to let go, and is refused
    // anyway: `reason` says so, and the panel must not answer it with the
    // button whose whole effect has already happened.
    const error = readFileSync(repo(`${APP_DIR}/Bardolier/BardolierError.swift`), 'utf8')
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
    // down every container on the Mac — bardolier's and everyone else's.
    const client = readFileSync(repo(`${APP_DIR}/Bardolier/BardolierClient.swift`), 'utf8')
    assert.match(client, /func eject\(root: String\? = nil, stopDocker: Bool = false\)/)
    assert.match(client, /stopDocker \? \["--stop-docker"\] : \[\]/)
    assert.match(store, /func closeAllAndEject\(root: String\? = nil, stopDocker: Bool = false\)/)
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
  const client = readFileSync(repo(`${APP_DIR}/Bardolier/BardolierClient.swift`), 'utf8')

  test('it defaults ON, and an unset key does not silently invert it', () => {
    assert.match(preferences, /object\(forKey: Self\.startOpensShellKey\) as\? Bool \?\? true/)
  })

  test('Start passes it to `up`, and says which Start it is', () => {
    assert.match(menu, /openShell: preferences\.startOpensShell/)
    assert.match(menu, /startOpensShell \? "Start & open shell" : "Start"/)
    assert.match(client, /openShell/)
  })

  test('a terminal that will not open is its own failure, with its own fix', () => {
    const error = readFileSync(repo(`${APP_DIR}/Bardolier/BardolierError.swift`), 'utf8')
    assert.match(error, /case terminalFailed\(terminal: String, underlying: String\)/)
    assert.match(error, /Pick a different terminal in Preferences/)
  })
})

describe('a missing bardolier is a first-run state (app-spec.md §13)', () => {
  const store = readFileSync(repo(`${APP_DIR}/BardolierStore.swift`), 'utf8')
  const panel = readFileSync(repo(`${APP_DIR}/Views/FirstRunPanel.swift`), 'utf8')
  const menu = readFileSync(repo(`${APP_DIR}/Views/MenuBarRootView.swift`), 'utf8')

  test('the store records it instead of reporting one failed command', () => {
    assert.match(store, /bardolierMissing = true/)
    assert.match(store, /bardolierSearchedLocations = BardolierExecutable\.searchedLocations/)
  })

  test('the menu shows the message in place of items that cannot work', () => {
    assert.match(menu, /if store\.bardolierMissing \{[\s\S]*?FirstRunPanel\(\)/)
  })

  test('it names an expected install location and the places actually searched', () => {
    assert.match(panel, /npm link/)
    assert.match(panel, /bin\/bardolier/)
    assert.match(panel, /store\.bardolierSearchedLocations/)
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
