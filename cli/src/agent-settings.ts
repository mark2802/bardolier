/**
 * The agent's default settings inside a project's `home/` — `cli-spec.md` §9.
 *
 * Claude Code adds a `Co-Authored-By` trailer and a "Generated with" line unless
 * `attribution` is set. `up` supplies empty strings when the key is absent, so
 * every project starts without them; a project that sets the key itself keeps
 * its value. Written by `up`, not seeded by `new`: a file in `home/` would make a
 * fresh project fail `delete` with PROJECT_HAS_DATA (§6).
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const SETTINGS_PATH = ['.claude', 'settings.json'] as const
const DEFAULT_TEXT = JSON.stringify({ attribution: { commit: '', pr: '' } }, null, 2) + '\n'

/** True for `path` when it is `<home>/.claude/settings.json` still holding exactly what `up` wrote — not the user's data. */
export function isUntouchedDefault(homeDir: string, path: string): boolean {
  if (path !== join(homeDir, ...SETTINGS_PATH)) return false
  try {
    return readFileSync(path, 'utf8') === DEFAULT_TEXT
  } catch {
    return false
  }
}

/** Returns true when the file was written. Unreadable or non-object JSON is left alone. */
export function ensureAttributionDefault(homeDir: string): boolean {
  const file = join(homeDir, ...SETTINGS_PATH)
  const dir = join(homeDir, SETTINGS_PATH[0])

  let settings: Record<string, unknown> = {}
  if (existsSync(file)) {
    try {
      const parsed: unknown = JSON.parse(readFileSync(file, 'utf8'))
      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return false
      settings = parsed as Record<string, unknown>
    } catch {
      return false
    }
  }
  if ('attribution' in settings) return false

  mkdirSync(dir, { recursive: true })
  writeFileSync(file, JSON.stringify({ ...settings, attribution: { commit: '', pr: '' } }, null, 2) + '\n')
  return true
}
