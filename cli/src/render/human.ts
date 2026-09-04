/**
 * HUMAN renderer. Never parsed by the app (cli-spec.md §2) — it is free to
 * change shape at any time. Deliberately shares no formatting code with
 * `render/json.ts`; the only thing the two have in common is the command's
 * data payload, which each formats on its own terms.
 */

import type { BandolierError } from '../errors.ts'
import type { CommandNode, FlagSpec } from '../commands/registry.ts'
import { COMMAND_GROUPS, flagLabel, walk } from '../commands/registry.ts'

export function renderHuman(lines: string[]): void {
  if (lines.length > 0) process.stdout.write(`${lines.join('\n')}\n`)
}

export function renderHumanError(error: BandolierError): void {
  process.stderr.write(`bandolier: ${error.message}  [${error.code}]\n`)
  if (error.details) {
    for (const [key, value] of Object.entries(error.details)) {
      process.stderr.write(`  ${key}: ${JSON.stringify(value)}\n`)
    }
  }
}

const GLOBAL_FLAGS = [
  ['--json', 'Emit a single JSON value on stdout (the app-facing contract).'],
  ['--help, -h', 'Show help for bandolier or for a command.'],
  ['--version, -v', 'Print the bandolier version.'],
] as const

function pad(left: string, width: number): string {
  return left.padEnd(width, ' ')
}

/** Top-level `bandolier --help`: every command, grouped as in cli-spec.md §6. */
export function renderRootHelp(root: CommandNode): string[] {
  const commands = walk(root)
  const width = Math.max(...commands.map((c) => c.usage.length), ...GLOBAL_FLAGS.map((f) => f[0].length)) + 2

  const lines: string[] = [
    'bandolier — Container Project Manager',
    '',
    'Manages containerised dev projects whose data lives on an external SSD.',
    'Every command accepts --json and prints a single JSON value on stdout.',
    '',
    'Usage:',
    '  bandolier <command> [args] [--json]',
    '',
  ]

  for (const group of COMMAND_GROUPS) {
    const inGroup = commands.filter((c) => c.group === group)
    if (inGroup.length === 0) continue
    lines.push(`${group}:`)
    for (const cmd of inGroup) {
      lines.push(`  ${pad(cmd.usage, width)}${cmd.summary}`)
    }
    lines.push('')
  }

  lines.push('Global flags:')
  for (const [flag, description] of GLOBAL_FLAGS) {
    lines.push(`  ${pad(flag, width)}${description}`)
  }
  lines.push('')
  lines.push('Behaviour is specified in docs/cli-spec.md.')
  return lines
}

/** `bandolier <command> --help`. */
export function renderCommandHelp(command: {
  usage: string
  summary: string
  flags: readonly FlagSpec[]
  errors: readonly string[]
}): string[] {
  const labels = [...command.flags.map(flagLabel), '--json']
  const width = Math.max(...labels.map((l) => l.length)) + 2

  const lines = [`Usage: bandolier ${command.usage}`, '', command.summary, '', 'Flags:']
  for (const flag of command.flags) {
    lines.push(`  ${pad(flagLabel(flag), width)}${flag.description}`)
  }
  lines.push(`  ${pad('--json', width)}Emit a single JSON value on stdout.`)
  if (command.errors.length > 0) {
    lines.push('')
    lines.push(`Error codes: ${command.errors.join(', ')}`)
  }
  return lines
}
