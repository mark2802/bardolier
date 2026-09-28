/**
 * Payloads for `bardolier root add | remove | list` — cli-spec.md §6 (Roots).
 *
 * `roots` is list-valued (cli-spec.md §8), which is exactly what `config set`
 * cannot edit (CLAUDE.md: "a list-valued key cannot be edited through
 * `config set`") — the same reasoning that gave `catalogue` and
 * `config get|set` their own command surfaces rather than a text field.
 */

/** One configured root, with whether it is currently readable. */
export type RootRow = {
  name: string
  path: string
  mounted: boolean
  /**
   * Additive, for parity with `status.roots[]` — `root
   * add|remove|list` never populate this themselves; it is here only so the
   * app's `ConfiguredRoot` model can be shared across both.
   */
  last_indexed?: string | null
}

export type RootAddOutput = {
  /** The config file written. */
  path: string
  /** True when the file did not exist before this call. */
  created: boolean
  added: RootRow
  /** Every configured root afterwards, in order. */
  roots: RootRow[]
}

export type RootRemoveOutput = {
  path: string
  removed: RootRow
  /** Every configured root afterwards, in order. */
  roots: RootRow[]
}

export type RootListOutput = {
  /** Every configured root, in order; `roots[0]` is the default `new` targets. */
  roots: RootRow[]
}
