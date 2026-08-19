/**
 * Entry point: resolve command → parse argv → run → render.
 *
 * The renderer is chosen HERE and only here. A command returns a payload and a
 * human-formatting function; it never writes to stdout itself. That keeps the
 * §2 guarantee intact — under `--json`, stdout carries exactly one JSON value.
 */

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { CprojError, EXIT_FAILURE, EXIT_SUCCESS, toCprojError } from './errors.ts'
import { parse } from './argv.ts'
import { ROOT, resolve } from './commands/registry.ts'
import { renderJson, renderJsonError } from './render/json.ts'
import { renderCommandHelp, renderHuman, renderHumanError, renderRootHelp } from './render/human.ts'

function version(): string {
  const pkgPath = fileURLToPath(new URL('../package.json', import.meta.url))
  const pkg = JSON.parse(readFileSync(pkgPath, 'utf8')) as { version?: string }
  return pkg.version ?? '0.0.0'
}

export async function main(argv: readonly string[]): Promise<number> {
  // `json` is resolved before anything can fail, so even a parse error is
  // reported in the machine format when --json was asked for.
  const wantsJson = argv.includes('--json')

  try {
    const { command, rest } = resolve(argv)
    const parsed = parse(rest, command)

    if (parsed.version) {
      if (parsed.json) renderJson({ version: version() })
      else renderHuman([`cproj ${version()}`])
      return EXIT_SUCCESS
    }

    // Bare `cproj`, `cproj --help`, or a grouping node like `cproj service`.
    const isGroupingNode = command !== null && (command.children?.length ?? 0) > 0
    if (command === null || parsed.help || isGroupingNode) {
      if (command === null && parsed.args.length > 0) {
        throw new CprojError('INVALID_ARGUMENT', `Unknown command \`${parsed.args[0]}\`. Try --help.`)
      }
      if (isGroupingNode && !parsed.help && parsed.args.length > 0) {
        throw new CprojError(
          'INVALID_ARGUMENT',
          `Unknown subcommand \`${parsed.args[0]}\` for \`cproj ${command.path.join(' ')}\`. Try --help.`,
        )
      }

      const help = command === null ? renderRootHelp(ROOT) : renderCommandHelp(command)
      if (parsed.json) renderJson({ help })
      else renderHuman(help)
      return EXIT_SUCCESS
    }

    const output = await command.run({ args: parsed.args, flags: parsed.flags })
    if (parsed.json) renderJson(output.json)
    else renderHuman(output.human(output.json))
    return EXIT_SUCCESS
  } catch (cause) {
    const error = toCprojError(cause)
    if (wantsJson) renderJsonError(error)
    else renderHumanError(error)
    return EXIT_FAILURE
  }
}

process.exitCode = await main(process.argv.slice(2))
