/**
 * MACHINE renderer. The app consumes only this.
 *
 * Contract (cli-spec.md §2): with `--json`, stdout is a SINGLE JSON value and
 * nothing else. No progress chatter, no banners — anything diagnostic goes to
 * stderr. Failures print the §2 error envelope here and exit non-zero.
 */

import type { CprojError, ErrorPayload } from '../errors.ts'

function write(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`)
}

export function renderJson(value: unknown): void {
  write(value)
}

export function renderJsonError(error: CprojError): void {
  const payload: ErrorPayload = error.toPayload()
  write(payload)
}
