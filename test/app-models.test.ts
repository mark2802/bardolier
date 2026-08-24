/**
 * The app's Codable models against the frozen schemas.
 *
 * Phase 5 puts a second reader of the CLI contract in the repo — `CprojClient`
 * and the `Codable` mirrors in `app/claude-yard/claude-yard/Cproj/`. Xcode is
 * host-only, so nothing in this repo compiles or runs that Swift; without a
 * check here, a schema field the models missed would surface as a decoding
 * failure in the menu bar, days later, with no test to catch it.
 *
 * So this reads the Swift as text and holds it to the same schemas
 * `contracts.test.ts` holds the CLI to, in both directions:
 *
 *   - every REQUIRED schema property has a Swift property (nothing missed), and
 *   - every Swift property is a DECLARED schema property (nothing invented,
 *     which under `additionalProperties: false` could never decode anyway).
 *
 * It is deliberately shallow about types — a text scan cannot judge Swift
 * types, and Xcode does that. What it judges is the field list, which is what
 * "additive only" is a promise about.
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import { ERROR_CODES } from '../cli/src/errors.ts'

const repo = (p: string) => fileURLToPath(new URL(`../${p}`, import.meta.url))
const APP_MODEL_DIR = 'app/claude-yard/claude-yard/Cproj'

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
  ['status', '', 'CprojStatus'],
  ['status', 'properties/ssd', 'SsdStatus'],
  ['status', 'properties/docker', 'DockerStatus'],
  ['status', '$defs/project', 'CprojProject'],
  ['status', '$defs/service', 'ProjectService'],
  ['status', '$defs/orphanedVolume', 'OrphanedVolume'],
  ['list', '', 'ProjectListOutput'],
  ['list', 'properties/projects/items', 'ProjectSummary'],
  ['doctor', '', 'DoctorOutput'],
  ['doctor', '$defs/finding', 'DoctorFinding'],
  ['shell', '', 'ShellInvocation'],
  ['new', '', 'NewOutput'],
  ['new', 'properties/project', 'CreatedProject'],
  ['new', '$defs/attached_service', 'AttachedService'],
  ['up', '', 'UpOutput'],
  ['up', 'properties/services/items', 'UpService'],
  ['down', '', 'DownOutput'],
  ['delete', '', 'DeleteOutput'],
  ['service-add', '', 'ServiceAddOutput'],
  ['service-add', '$defs/attached_service', 'AttachedService'],
  ['service-remove', '', 'ServiceRemoveOutput'],
  ['service-remove', 'properties/removed', 'RemovedService'],
  ['service-list', '', 'ServiceListOutput'],
  ['volumes-orphaned', '', 'OrphanedVolumesOutput'],
  ['volumes-orphaned', '$defs/orphanedVolume', 'OrphanedVolume'],
  ['volumes-rm', '', 'VolumeRemoveOutput'],
  ['down-all', '', 'DownAllOutput'],
  ['down-all', 'properties/projects/items', 'DownAllProject'],
  ['eject', '', 'EjectOutput'],
  ['eject', '$defs/holder', 'SsdHolder'],
  ['build', '', 'BuildOutput'],
  ['build', 'properties/images/items', 'BaseImage'],
  ['error', '', 'CprojErrorEnvelope'],
  ['error', 'properties/error', 'CprojErrorBody'],
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
  const source = readFileSync(repo(`${APP_MODEL_DIR}/CprojError.swift`), 'utf8')
  const declared = new Set(
    [...source.matchAll(/CprojErrorCode\(rawValue:\s*"([A-Z_]+)"\)/g)].map((match) => match[1]),
  )

  test('every code in errors.ts has a CprojErrorCode constant', () => {
    for (const code of ERROR_CODES) {
      assert.ok(declared.has(code), `CprojError.swift has no constant for \`${code}\``)
    }
  })

  test('the app invents no code the CLI cannot emit', () => {
    for (const code of declared) {
      assert.ok(
        (ERROR_CODES as readonly string[]).includes(code as string),
        `CprojError.swift declares \`${code}\`, which errors.ts does not define`,
      )
    }
  })
})

describe('the app calls the CLI the way the CLI expects', () => {
  const client = readFileSync(repo(`${APP_MODEL_DIR}/CprojClient.swift`), 'utf8')

  test('--json is appended by the client, not by callers (cli-spec.md §2)', () => {
    const appended = /let arguments = argv \+ \["--json"\]/.test(client)
    assert.ok(appended, 'CprojClient.run must append --json itself')
    const callerPassed = /"--json"/g
    assert.equal(client.match(callerPassed)?.length, 1, 'only one place may add --json')
  })

  test('destructive commands pass --force, since --json refuses to prompt', () => {
    for (const command of [/"delete", project, "--force"/, /"volumes", "rm", name, "--force"/]) {
      assert.match(client, command)
    }
  })
})

describe('the app spawns nothing but cproj', () => {
  /** Every Swift source in the app target, path → contents. */
  const sources = new Map<string, string>(
    readdirSync(repo('app/claude-yard/claude-yard'), { recursive: true, encoding: 'utf8' })
      .filter((entry) => entry.endsWith('.swift'))
      .map((entry) => [entry, readFileSync(repo(`app/claude-yard/claude-yard/${entry}`), 'utf8')]),
  )

  test('there are Swift sources to check', () => {
    assert.ok(sources.size >= 5, `found ${sources.size} Swift files under the app target`)
  })

  test('only the client constructs a Process', () => {
    for (const [file, source] of sources) {
      if (file.endsWith('CprojClient.swift')) continue
      assert.doesNotMatch(source, /\bProcess\(\)/, `${file} launches a process; only CprojClient may`)
    }
  })

  test('the client launches only the resolved cproj executable', () => {
    const client = sources.get('Cproj/CprojClient.swift')
    assert.ok(client, 'CprojClient.swift is missing')
    // One assignment, and it is the located binary — not a shell, not `docker`.
    assert.equal(client.match(/executableURL\s*=/g)?.length, 1)
    assert.match(client, /process\.executableURL = executable/)
    assert.doesNotMatch(client, /"\/bin\/(ba)?sh"|"-c"|launchPath/)
  })
})
