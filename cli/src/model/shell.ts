/**
 * Payload for `bandolier shell <name>` — `cli-spec.md` §6 (Shell).
 *
 * The CLI NAMES the command; the app spawns the terminal. That split is the
 * whole contract here: this payload is an instruction to be executed elsewhere,
 * which is why `exec` is an argv ARRAY and not a string. The app passes it
 * straight to its process API with no quoting, no shell, and no parsing of
 * human output (§2).
 *
 * App-facing: additive changes only once the app ships (Phase 5+).
 */

export type ShellOutput = {
  project: string
  /** The running dev container, e.g. `bandolier-myapp`. */
  container: string
  /** Argv to run, e.g. `["docker","exec","-it","bandolier-myapp","bash"]` (§6). */
  exec: string[]
  /** Where that shell lands — the bind-mounted project directory inside the container. */
  workdir: string
}
