/**
 * `bardolier config get | set` — `cli-spec.md` §8.
 *
 * Not in §6's original list, and here for the reason §1 gives: the app holds no
 * logic of its own, so Preferences (`app-spec.md` §12) changes the catalogue
 * path and the terminal by calling the CLI rather than by writing `config.yml`
 * behind it. `roots` is list-valued and has its own surface instead
 * (`bardolier root add | remove | list`, phase 18). Precedence and path expansion
 * live in `config.ts`; a second writer in Swift would know some of that and
 * get the rest subtly wrong.
 *
 * `get` reports the EFFECTIVE config — what the CLI will actually use — plus
 * the environment overrides, because a value forced by `$BARDOLIER_ROOT` is one
 * the file cannot change, and a preferences pane that silently wrote it anyway
 * would be lying to the user.
 *
 * Neither command touches a root's disk: the config file lives on the
 * internal disk precisely so it stays readable when every root is absent (§8).
 */

import type { Context } from '../context.ts'
import { CONFIG_KEYS, isConfigKey, loadConfig, writeConfig, type ConfigKey } from '../config.ts'
import { BardolierError } from '../errors.ts'
import type { ConfigGetOutput, ConfigSetOutput, EffectiveConfig } from '../model/config.ts'

function effective(ctx: Context): EffectiveConfig {
  return {
    catalogue_path: ctx.config.catalogue_path,
    terminal: ctx.config.terminal,
  }
}

export function collectConfigGet(ctx: Context): ConfigGetOutput {
  return {
    path: ctx.loaded.path,
    exists: ctx.loaded.exists,
    config: effective(ctx),
    overrides: [...ctx.loaded.overrides],
  }
}

export function renderConfigGet(output: ConfigGetOutput): string[] {
  const lines = [`Config: ${output.path}${output.exists ? '' : ' (does not exist yet)'}`, '']
  for (const key of CONFIG_KEYS) {
    const value = output.config[key]
    lines.push(`  ${key.padEnd(15)}${value ?? '(unset — §4.1 fallback applies)'}`)
  }
  if (output.overrides.length > 0) {
    lines.push('')
    lines.push(`Overridden by the environment: ${output.overrides.join(', ')}.`)
    lines.push('Those win over the file, so `bardolier config set` cannot change them here.')
  }
  return lines
}

export type ConfigSetRequest = {
  readonly key: string | undefined
  readonly value: string | undefined
}

export function runConfigSet(ctx: Context, request: ConfigSetRequest): ConfigSetOutput {
  const { key, value } = request
  if (key === undefined || value === undefined) {
    throw new BardolierError('INVALID_ARGUMENT', 'Usage: bardolier config set <key> <value>   (an empty value clears the key)')
  }
  if (!isConfigKey(key)) {
    throw new BardolierError(
      'INVALID_ARGUMENT',
      `\`${key}\` is not a config key. Settable keys: ${CONFIG_KEYS.join(', ')}.`,
    )
  }

  const updates: Partial<Record<ConfigKey, string>> = {}
  updates[key] = value
  const write = writeConfig(ctx.loaded.path, updates, ctx.loaded.home)
  // Re-load rather than patch the in-memory config: precedence is config.ts's
  // to apply, and the reloaded answer is what the next command will see. Same
  // inputs as the original load, or the reload would answer for a different
  // environment than the one that ran the command.
  const reloaded = loadConfig({ path: ctx.loaded.path, env: ctx.loaded.env, home: ctx.loaded.home })

  return {
    path: write.path,
    created: write.created,
    changed: [...write.changed],
    config: {
      catalogue_path: reloaded.config.catalogue_path,
      terminal: reloaded.config.terminal,
    },
    overrides: [...reloaded.overrides],
  }
}

export function renderConfigSet(output: ConfigSetOutput): string[] {
  const lines: string[] = []
  if (output.changed.length === 0) {
    lines.push(`No change — ${output.path} already said that.`)
  } else {
    lines.push(`${output.created ? 'Created' : 'Updated'} ${output.path}: ${output.changed.join(', ')}.`)
  }
  lines.push('')
  for (const key of CONFIG_KEYS) {
    lines.push(`  ${key.padEnd(15)}${output.config[key] ?? '(unset)'}`)
  }
  const blocked = output.changed.filter((key) => output.overrides.includes(`BARDOLIER_${key.toUpperCase()}`))
  if (blocked.length > 0) {
    lines.push('')
    lines.push(`Written, but the environment still wins for: ${blocked.join(', ')}.`)
  }
  return lines
}
