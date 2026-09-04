/**
 * Confirmation prompts for destructive actions.
 *
 * "Safety over convenience for destructive actions" (CLAUDE.md) needs a way to
 * ask — but a prompt is I/O, so it goes through the Context seam like every
 * other side effect, and it writes to STDERR. Under `--json` stdout carries
 * exactly one JSON value (§2); a question printed there would corrupt it.
 *
 * With no terminal there is nobody to ask, and guessing "yes" would delete a
 * project on a whim. That case is a refusal, not a default.
 */

import { createInterface } from 'node:readline'
import { BardolierError } from './errors.ts'

/** Resolves true only on an explicit yes. */
export type Confirm = (question: string) => Promise<boolean>

export function createConfirm(
  input: NodeJS.ReadStream = process.stdin,
  output: NodeJS.WriteStream = process.stderr,
): Confirm {
  return (question) =>
    new Promise((resolve, reject) => {
      if (!input.isTTY) {
        reject(
          new BardolierError(
            'INVALID_ARGUMENT',
            'Cannot ask for confirmation without a terminal. Re-run with --force if you mean it.',
          ),
        )
        return
      }
      const rl = createInterface({ input, output })
      rl.question(`${question} [y/N] `, (answer) => {
        rl.close()
        resolve(/^y(es)?$/i.test(answer.trim()))
      })
    })
}
