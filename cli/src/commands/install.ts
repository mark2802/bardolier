/**
 * `bardolier install [--bin-dir <dir>] [--force]` — `cli-spec.md` §6
 * (Lifecycle / SSD), phase 28.
 *
 * The thin command wrapper; the actual search-and-link logic lives in
 * `../install.ts`, which is also what `doctor`'s `cli` finding calls to ask
 * the same question. No `Context` here — see that module's header for why.
 */

import { runInstall } from '../install.ts'
import type { InstallOutput } from '../model/install.ts'

export { runInstall }

export function renderInstall(output: InstallOutput): string[] {
  const lines = [`bin dir:  ${output.bin_dir}${output.created_bin_dir ? '  (created)' : ''}`]
  for (const link of output.links) {
    const verb = link.action === 'already_linked' ? 'already linked' : link.action
    lines.push(`  ${link.name.padEnd(9)} ${verb.padEnd(15)} ${link.path} → ${link.target}`)
  }
  lines.push('')
  lines.push(
    output.node_ok
      ? `node ${output.node_version}  ✓ satisfies cli/package.json's engines.node`
      : `node ${output.node_version}  ✗ does not satisfy cli/package.json's engines.node`,
  )
  lines.push(
    output.resolves
      ? '✓ `bardolier` resolves under this bin dir with no shell PATH — a Finder-launched app will find it.'
      : '✗ `bardolier` does not resolve there yet — something above did not land.',
  )
  return lines
}
