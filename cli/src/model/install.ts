/**
 * Payload for `bardolier install` — `cli-spec.md` §6 (Lifecycle / SSD).
 *
 * Not app-facing the way `status` or `new` are — the app never runs this
 * itself, a person or `npm run setup` does, once, before the app exists on
 * this machine at all — but it is still `--json` shaped like everything
 * else, and `doctor`'s new `cli` finding answers the same question this
 * command changes the answer to.
 */

export type InstallLinkAction = 'created' | 'already_linked' | 'replaced'

export type InstallLink = {
  /** `bardolier` or `bdlr` — the two names `cli/package.json`'s `bin` map declares. */
  name: string
  /** Absolute path of the link, `<bin_dir>/<name>`. */
  path: string
  /** The real path of `cli/bin/bardolier.js` this checkout resolves to. */
  target: string
  action: InstallLinkAction
}

export type InstallOutput = {
  bin_dir: string
  links: InstallLink[]
  /** True when no conventional directory existed and `bin_dir` (~/.local/bin) was created. */
  created_bin_dir: boolean
  /** The node running this install — what actually matters is `node_ok`. */
  node_version: string
  /** Whether the running node satisfies cli/package.json's engines.node. */
  node_ok: boolean
  /**
   * Whether `bardolier` resolves under `bin_dir` plus the system directories
   * alone — no inherited shell PATH — mirroring the search a Finder-launched
   * app actually performs (`BardolierExecutable.swift`).
   */
  resolves: boolean
}
