/**
 * The app's Codable models against the frozen schemas, in both directions:
 * every required schema property has a Swift property, and every Swift property
 * is a declared one (`additionalProperties: false` would never decode it
 * otherwise). Xcode is host-only, so nothing here compiles the Swift — without
 * this scan a missed field surfaces as a decoding failure in the menu bar days
 * later. Deliberately shallow about types; the field list is what "additive
 * only" is a promise about.
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import { ERROR_CODES } from '../cli/src/errors.ts'
import { CATALOGUE_ORIGINS } from '../cli/src/catalogue.ts'
import { ORPHAN_KINDS } from '../cli/src/model/status.ts'
import { CONFIG_KEYS } from '../cli/src/config.ts'

const repo = (p: string) => fileURLToPath(new URL(`../${p}`, import.meta.url))
const APP_MODEL_DIR = 'app/bardolier/bardolier/Bardolier'

// ── Reading the Swift ────────────────────────────────────────────────────────

/** Stored properties of one Swift struct, in declaration order. */
type SwiftStruct = {
  readonly name: string
  readonly properties: string[]
  readonly file: string
}

/**
 * Extract `struct X { let a: A; var b: B }` declarations. Only stored
 * properties count: a computed one (`var id: String { name }`) carries a brace
 * on its line and is not part of the wire shape.
 */
function parseSwiftStructs(source: string, file: string): SwiftStruct[] {
  const structs: SwiftStruct[] = []
  const declaration = /(?:^|\n)(?:nonisolated\s+)?(?:private\s+|final\s+)*struct\s+(\w+)[^{]*\{/g

  for (let match = declaration.exec(source); match !== null; match = declaration.exec(source)) {
    const name = match[1]
    if (name === undefined) continue

    // Walk braces from the opening one so a nested block cannot end the struct
    // early and a following struct cannot be swallowed.
    let depth = 0
    let end = match.index + match[0].length - 1
    for (let i = end; i < source.length; i += 1) {
      const char = source[i]
      if (char === '{') depth += 1
      else if (char === '}') {
        depth -= 1
        if (depth === 0) {
          end = i
          break
        }
      }
    }

    const body = source.slice(match.index + match[0].length, end)
    const properties: string[] = []
    for (const line of body.split('\n')) {
      const property = /^\s{4}(?:let|var)\s+(\w+)\s*:/.exec(line)
      if (property?.[1] !== undefined && !line.includes('{')) properties.push(property[1])
    }
    structs.push({ name, properties, file })
  }
  return structs
}

const swiftStructs = new Map<string, SwiftStruct>(
  readdirSync(repo(APP_MODEL_DIR))
    .filter((file) => file.endsWith('.swift'))
    .flatMap((file) => parseSwiftStructs(readFileSync(repo(`${APP_MODEL_DIR}/${file}`), 'utf8'), file))
    .map((struct) => [struct.name, struct]),
)

// ── Reading the schemas ──────────────────────────────────────────────────────

type SchemaObject = {
  properties?: Record<string, unknown>
  required?: string[]
  $defs?: Record<string, SchemaObject>
  items?: SchemaObject
  additionalProperties?: unknown
}

function loadSchema(name: string): SchemaObject {
  return JSON.parse(readFileSync(repo(`cli/schema/${name}.schema.json`), 'utf8')) as SchemaObject
}

/** Resolve a slash path like `properties/services/items` within a schema. */
function at(schema: SchemaObject, path: string): SchemaObject {
  if (path === '') return schema
  let node: SchemaObject = schema
  for (const segment of path.split('/')) {
    const next = (node as unknown as Record<string, SchemaObject | Record<string, SchemaObject>>)[segment]
    assert.ok(next, `no \`${segment}\` under \`${path}\` — the mapping below is stale`)
    node = next as SchemaObject
  }
  return node
}

/** `host_port` → `hostPort`, matching JSONDecoder's `.convertFromSnakeCase`. */
function camel(key: string): string {
  return key.replace(/_([a-z0-9])/g, (_, c: string) => c.toUpperCase())
}

/**
 * Which Swift struct mirrors which schema object. Written out rather than
 * inferred: the point is to state the intended correspondence so a drifting
 * one fails loudly instead of quietly matching nothing.
 */
const MIRRORS: readonly (readonly [schema: string, path: string, swift: string])[] = [
  ['status', '', 'BardolierStatus'],
  ['status', 'properties/ssd', 'SsdStatus'],
  ['status', 'properties/docker', 'DockerStatus'],
  ['status', '$defs/project', 'BardolierProject'],
  ['status', '$defs/service', 'ProjectService'],
  ['status', '$defs/orphanedVolume', 'OrphanedVolume'],
  ['list', '', 'ProjectListOutput'],
  ['list', 'properties/projects/items', 'ProjectSummary'],
  ['doctor', '', 'DoctorOutput'],
  ['doctor', '$defs/finding', 'DoctorFinding'],
  ['doctor', '$defs/doctor_root', 'DoctorRootState'],
  ['shell', '', 'ShellInvocation'],
  ['new', '', 'NewOutput'],
  ['new', 'properties/project', 'CreatedProject'],
  ['new', '$defs/attached_service', 'AttachedService'],
  ['clone', '', 'CloneOutput'],
  ['clone', 'properties/project', 'CreatedProject'],
  ['clone', '$defs/attached_service', 'AttachedService'],
  ['move', '', 'MoveOutput'],
  ['move', '$defs/location', 'MoveLocation'],
  ['up', '', 'UpOutput'],
  ['up', 'properties/services/items', 'UpService'],
  ['down', '', 'DownOutput'],
  ['delete', '', 'DeleteOutput'],
  ['service-add', '', 'ServiceAddOutput'],
  ['service-add', '$defs/attached_service', 'AttachedService'],
  ['service-remove', '', 'ServiceRemoveOutput'],
  ['service-remove', 'properties/removed', 'RemovedService'],
  ['service-list', '', 'ServiceListOutput'],
  ['port-add', '', 'PortAddOutput'],
  ['port-add', '$defs/attached_extra_port', 'AttachedExtraPort'],
  ['port-remove', '', 'PortRemoveOutput'],
  ['port-remove', 'properties/removed', 'RemovedExtraPort'],
  ['port-list', '', 'PortListOutput'],
  ['deps-add', '', 'DepsAddOutput'],
  ['deps-remove', '', 'DepsRemoveOutput'],
  ['deps-list', '', 'DepsListOutput'],
  ['volumes-orphaned', '', 'OrphanedVolumesOutput'],
  ['volumes-orphaned', '$defs/orphanedVolume', 'OrphanedVolume'],
  ['volumes-rm', '', 'VolumeRemoveOutput'],
  ['down-all', '', 'DownAllOutput'],
  ['down-all', 'properties/projects/items', 'DownAllProject'],
  ['eject', '', 'EjectOutput'],
  ['eject', '$defs/holder', 'SsdHolder'],
  ['eject-all', '', 'EjectAllOutput'],
  ['eject-all', '$defs/result', 'EjectAllResult'],
  ['eject-all', '$defs/holder', 'SsdHolder'],
  ['build', '', 'BuildOutput'],
  ['build', 'properties/images/items', 'BaseImage'],
  ['catalogue', '', 'CatalogueOutput'],
  ['catalogue', '$defs/catalogue_service', 'CatalogueService'],
  ['config-get', '', 'ConfigGetOutput'],
  ['config-get', '$defs/effective_config', 'EffectiveConfig'],
  ['config-set', '', 'ConfigSetOutput'],
  ['root-add', '', 'RootAddOutput'],
  ['root-add', '$defs/root', 'ConfiguredRoot'],
  ['root-remove', '', 'RootRemoveOutput'],
  ['root-list', '', 'RootListOutput'],
  ['status', '$defs/configured_root', 'ConfiguredRoot'],
  ['error', '', 'BardolierErrorEnvelope'],
  ['error', 'properties/error', 'BardolierErrorBody'],
]

describe('app models mirror the frozen schemas', () => {
  test('every schema object named above has a Swift struct', () => {
    for (const [schema, path, swift] of MIRRORS) {
      assert.ok(swiftStructs.has(swift), `${schema}.schema.json ${path || '(root)'} → no Swift struct \`${swift}\``)
    }
  })

  for (const [schemaName, path, swiftName] of MIRRORS) {
    const label = `${schemaName}${path ? ` ${path}` : ''} → ${swiftName}`

    test(`${label}: no required property is missing`, () => {
      const node = at(loadSchema(schemaName), path)
      const swift = swiftStructs.get(swiftName)
      assert.ok(swift, `no Swift struct \`${swiftName}\``)
      for (const key of node.required ?? []) {
        assert.ok(
          swift.properties.includes(camel(key)),
          `\`${key}\` is required by ${schemaName}.schema.json but ${swiftName} has no \`${camel(key)}\``,
        )
      }
    })

    test(`${label}: no property is invented`, () => {
      const node = at(loadSchema(schemaName), path)
      const swift = swiftStructs.get(swiftName)
      assert.ok(swift, `no Swift struct \`${swiftName}\``)
      const declared = new Set(Object.keys(node.properties ?? {}).map(camel))
      for (const property of swift.properties) {
        assert.ok(
          declared.has(property),
          `${swiftName}.${property} is in no ${schemaName}.schema.json property — it can never decode`,
        )
      }
    })
  }
})

describe('the app knows every error code', () => {
  const source = readFileSync(repo(`${APP_MODEL_DIR}/BardolierError.swift`), 'utf8')
  const declared = new Set(
    [...source.matchAll(/BardolierErrorCode\(rawValue:\s*"([A-Z_]+)"\)/g)].map((match) => match[1]),
  )

  test('every code in errors.ts has a BardolierErrorCode constant', () => {
    for (const code of ERROR_CODES) {
      assert.ok(declared.has(code), `BardolierError.swift has no constant for \`${code}\``)
    }
  })

  test('the app invents no code the CLI cannot emit', () => {
    for (const code of declared) {
      assert.ok(
        (ERROR_CODES as readonly string[]).includes(code as string),
        `BardolierError.swift declares \`${code}\`, which errors.ts does not define`,
      )
    }
  })
})

describe('the app knows the tokens the CLI can emit', () => {
  const source = readFileSync(repo(`${APP_MODEL_DIR}/BardolierModels.swift`), 'utf8')

  /** `static let x = Token(rawValue: "…")` constants for one token type. */
  function constants(type: string): Set<string> {
    const matches = [...source.matchAll(new RegExp(`${type}\\(rawValue:\\s*"([a-z_]+)"\\)`, 'g'))]
    return new Set(matches.flatMap((match) => (match[1] === undefined ? [] : [match[1]])))
  }

  test('every catalogue origin has a CatalogueOrigin constant', () => {
    const declared = constants('CatalogueOrigin')
    for (const origin of CATALOGUE_ORIGINS) {
      assert.ok(declared.has(origin), `BardolierModels.swift has no CatalogueOrigin for \`${origin}\``)
    }
  })

  test('every orphan kind has an OrphanKind constant', () => {
    const declared = constants('OrphanKind')
    for (const kind of ORPHAN_KINDS) {
      assert.ok(declared.has(kind), `BardolierModels.swift has no OrphanKind for \`${kind}\``)
    }
  })

  test('every settable config key has a ConfigKey constant, and no others', () => {
    const declared = constants('ConfigKey')
    for (const key of CONFIG_KEYS) {
      assert.ok(declared.has(key), `BardolierModels.swift has no ConfigKey for \`${key}\``)
    }
    for (const key of declared) {
      assert.ok(
        (CONFIG_KEYS as readonly string[]).includes(key as string),
        `BardolierModels.swift declares ConfigKey \`${key}\`, which \`bardolier config set\` would reject`,
      )
    }
  })
})

describe('the app re-derives nothing the CLI reports', () => {
  /**
   * Swift that renders LIVE data. `DebugStatusView.swift` is excluded on
   * purpose: its literals are a canned `bardolier status` payload for `#Preview`,
   * i.e. CLI output pasted in, which is the opposite of the app composing a
   * value of its own.
   */
  const sources = new Map<string, string>(
    readdirSync(repo('app/bardolier/bardolier'), { recursive: true, encoding: 'utf8' })
      .filter((entry) => entry.endsWith('.swift') && !entry.endsWith('DebugStatusView.swift'))
      .map((entry) => [entry, code(readFileSync(repo(`app/bardolier/bardolier/${entry}`), 'utf8'))]),
  )

  /** Source with comment lines removed — prose may name what code may not do. */
  function code(source: string): string {
    return source
      .split('\n')
      .filter((line) => !line.trim().startsWith('//'))
      .join('\n')
  }

  test('no connection string is built in Swift (cli-spec.md §7, connection_hint)', () => {
    for (const [file, source] of sources) {
      // A `localhost:` literal in rendering code means the app is composing
      // what the CLI already reported — and the prod-like topology rule
      // (CLAUDE.md) says the app must never wire anything to localhost itself.
      assert.doesNotMatch(source, /localhost:/, `${file} builds a localhost address; connection_hint is the CLI's`)
    }
  })

  test('the project directory comes from status, not from ssd.root', () => {
    const menu = sources.get('Views/MenuBarRootView.swift')
    assert.ok(menu, 'MenuBarRootView.swift is missing')
    assert.match(menu, /revealInFinder\(project\.dir\)/, 'Finder must be given the dir the CLI reported')
  })

  test('the app writes the config file only through the CLI (app-spec.md §12)', () => {
    for (const [file, source] of sources) {
      assert.doesNotMatch(source, /config\.yml/, `${file} names the config file; only \`bardolier config set\` may write it`)
    }
  })
})

describe('the app can actually find the terminal (app-spec.md §7)', () => {
  const source = readFileSync(repo('app/bardolier/bardolier/Shell/BardolierTerminal.swift'), 'utf8')

  // Guessing where an app lives was a real bug: Terminal.app is in
  // /System/Applications/Utilities, so a search of the obvious folders found
  // every terminal EXCEPT the default one. Launch Services knows where an app
  // is; the folder list is only a fallback for names it has no id for.
  test('it asks Launch Services where an app is', () => {
    assert.match(source, /urlForApplication\(withBundleIdentifier:/)
    assert.match(source, /"com\.apple\.Terminal"/, 'the default terminal needs an id to look up')
  })

  test('the fallback search covers both Utilities folders', () => {
    assert.match(source, /"\/System\/Applications\/Utilities"/)
    assert.match(source, /"\/Applications\/Utilities"/)
  })

  test('a terminal that cannot be found still opens a shell', () => {
    // NSWorkspace.open(file) with no app named = whatever handles .command.
    assert.match(source, /NSWorkspace\.shared\.open\(file\)/)
  })

  // Terminal TYPES the command into a new login shell, before that shell's rc
  // files have finished. An rc that reads a keystroke (oh-my-zsh's update
  // prompt) ate the first character, and the shell ran a truncated command.
  test('the typed command survives an rc file that reads a keystroke', () => {
    assert.match(source, /func guarded\(_ command: String\) -> String \{\s*\n\s*":\\n" \+ command/)
    assert.match(source, /do script \\\(literal\(guarded\(command\)\)\)/, 'Terminal is typed at, so it needs the guard line')
    // iTerm runs the command as the session's process rather than typing it at
    // a shell, so a guard line there would be a stray command, not a shield.
    assert.match(source, /default profile command \\\(literal\(command\)\)/, 'iTerm must get the command unguarded')
  })
})

describe('a downgraded shell says so and keeps saying so (app-spec.md §7)', () => {
  const store = readFileSync(repo('app/bardolier/bardolier/BardolierStore.swift'), 'utf8')
  const menu = readFileSync(repo('app/bardolier/bardolier/Views/MenuBarRootView.swift'), 'utf8')

  // Opening the menu refreshes, and a refresh clears `notice` — so the note
  // explaining why a shell fell back to the .command route was wiped before
  // anyone could read it. It needs its own state, like `ejectPhase`.
  test('the note lands in shellDowngrade, not in notice', () => {
    assert.match(store, /var shellDowngrade: String\?/)
    assert.match(store, /BardolierTerminal\.open\(invocation, in: terminalName\) \{\s*\n\s*shellDowngrade = note/)
  })

  test('only the user or a clean shell clears it', () => {
    assert.match(store, /func clearShellDowngrade\(\) \{\s*\n\s*shellDowngrade = nil/)
    // Twice: the success path of openShell, and the dismiss button's call.
    // A third would mean something else — a refresh — is wiping it again.
    assert.equal(store.match(/shellDowngrade = nil/g)?.length, 2)
  })

  test('the menu renders it', () => {
    assert.match(menu, /WarningBanner\(text: downgrade\) \{ store\.clearShellDowngrade\(\) \}/)
  })
})

describe('the app calls the CLI the way the CLI expects', () => {
  const client = readFileSync(repo(`${APP_MODEL_DIR}/BardolierClient.swift`), 'utf8')

  test('--json is appended by the client, not by callers (cli-spec.md §2)', () => {
    const appended = /let arguments = argv \+ \["--json"\]/.test(client)
    assert.ok(appended, 'BardolierClient.run must append --json itself')
    const callerPassed = /"--json"/g
    assert.equal(client.match(callerPassed)?.length, 1, 'only one place may add --json')
  })

  test('destructive commands pass --force, since --json refuses to prompt', () => {
    for (const command of [/"delete", project, "--force"/, /"volumes", "rm", name, "--force"/]) {
      assert.match(client, command)
    }
  })
})

describe('the app spawns nothing but bardolier', () => {
  /** Every Swift source in the app target, path → contents. */
  const sources = new Map<string, string>(
    readdirSync(repo('app/bardolier/bardolier'), { recursive: true, encoding: 'utf8' })
      .filter((entry) => entry.endsWith('.swift'))
      .map((entry) => [entry, readFileSync(repo(`app/bardolier/bardolier/${entry}`), 'utf8')]),
  )

  test('there are Swift sources to check', () => {
    assert.ok(sources.size >= 5, `found ${sources.size} Swift files under the app target`)
  })

  test('only the client constructs a Process', () => {
    for (const [file, source] of sources) {
      if (file.endsWith('BardolierClient.swift')) continue
      assert.doesNotMatch(source, /\bProcess\(\)/, `${file} launches a process; only BardolierClient may`)
    }
  })

  test('the client launches only the resolved bardolier executable', () => {
    const client = sources.get('Bardolier/BardolierClient.swift')
    assert.ok(client, 'BardolierClient.swift is missing')
    // One assignment, and it is the located binary — not a shell, not `docker`.
    assert.equal(client.match(/executableURL\s*=/g)?.length, 1)
    assert.match(client, /process\.executableURL = executable/)
    assert.doesNotMatch(client, /"\/bin\/(ba)?sh"|"-c"|launchPath/)
  })
})
