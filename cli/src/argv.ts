/**
 * Argument parsing. Deliberately small and hand-rolled: the surface is fixed by
 * cli-spec.md §6, and unknown flags must fail loudly with INVALID_ARGUMENT
 * rather than being silently ignored — a silently-dropped `--json` would hand
 * the app human output to parse.
 */

import { BandolierError } from './errors.ts'
import type { CommandNode } from './commands/registry.ts'

export type ParsedFlags = Record<string, string | boolean>

export type Parsed = {
  readonly args: string[]
  readonly flags: ParsedFlags
  readonly json: boolean
  readonly help: boolean
  readonly version: boolean
}

/** `--archetype` → `archetype`, `--no-shell` → `noShell`. */
export function flagKey(name: string): string {
  return name.replace(/^--/, '').replace(/-([a-z])/g, (_, c: string) => c.toUpperCase())
}

const GLOBAL: Record<string, 'json' | 'help' | 'version'> = {
  '--json': 'json',
  '--help': 'help',
  '-h': 'help',
  '--version': 'version',
  '-v': 'version',
}

/**
 * Parse the tokens left after the command path is resolved. `command` is null
 * for a bare `bandolier`, where only global flags are accepted.
 */
export function parse(tokens: readonly string[], command: CommandNode | null): Parsed {
  const args: string[] = []
  const flags: ParsedFlags = {}
  let json = false
  let help = false
  let version = false

  const known = new Map(
    (command?.flags ?? []).map((f) => [f.name, f] as const),
  )

  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i]
    if (token === undefined) continue

    if (!token.startsWith('-') || token === '-') {
      args.push(token)
      continue
    }

    // `--flag=value`
    const eq = token.indexOf('=')
    const name = eq === -1 ? token : token.slice(0, eq)
    const inlineValue = eq === -1 ? null : token.slice(eq + 1)

    const global = GLOBAL[name]
    if (global) {
      if (inlineValue !== null) {
        throw new BandolierError('INVALID_ARGUMENT', `\`${name}\` does not take a value.`)
      }
      if (global === 'json') json = true
      else if (global === 'help') help = true
      else version = true
      continue
    }

    const spec = known.get(name)
    if (!spec) {
      const where = command ? `\`bandolier ${command.path.join(' ')}\`` : 'bandolier'
      throw new BandolierError('INVALID_ARGUMENT', `Unknown flag \`${name}\` for ${where}. Try --help.`)
    }

    const key = flagKey(spec.name)
    if (!spec.arg) {
      if (inlineValue !== null) {
        throw new BandolierError('INVALID_ARGUMENT', `\`${spec.name}\` does not take a value.`)
      }
      flags[key] = true
      continue
    }

    let value = inlineValue
    if (value === null) {
      const next = tokens[i + 1]
      if (next === undefined || next.startsWith('-')) {
        throw new BandolierError('INVALID_ARGUMENT', `\`${spec.name}\` requires a value (${spec.arg}).`)
      }
      value = next
      i += 1
    }
    flags[key] = value
  }

  return { args, flags, json, help, version }
}
