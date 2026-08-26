/**
 * Git, behind the Context seam — `cli-spec.md` §9, §12.
 *
 * Two unrelated-looking questions live here because they are the same side
 * effect: spawning `git` on the host. A command may not do that itself (the
 * Context rule), and both callers need it.
 *
 *   - `identity()` answers who the human is, so `up` can lend the dev container
 *     `GIT_AUTHOR_*`/`GIT_COMMITTER_*`. The container has git but no identity
 *     of its own, and a commit made in there would otherwise fail on an unset
 *     `user.email` — the most boring possible way for an agent's work to be
 *     lost.
 *   - `facts()` answers what happened in a project, so `down` can write the
 *     handoff note (§12). It reads: nothing here writes to a repository, and
 *     nothing here fails a command — a project that is not a git repo at all is
 *     a `null`, not an error.
 *
 * Everything is best-effort by construction. `git` missing, a directory that is
 * not a repo, a repo with no commits yet: all of them are an absent answer
 * rather than a thrown one, because neither caller is important enough to fail
 * a start or a stop over.
 */

import { execFile } from 'node:child_process'

/** Who commits are attributed to, as far as the host's git config knows. */
export type GitIdentity = {
  readonly name: string | null
  readonly email: string | null
}

/** What a project looked like when it was stopped (§12). */
export type GitFacts = {
  readonly branch: string | null
  /** `<short-sha> <subject>`, newest first, capped at RECENT_COMMITS. */
  readonly commits: readonly string[]
  /**
   * Porcelain entries for uncommitted work — ALL of them, uncapped.
   *
   * Truncating here would make `status.length` a lie, and the count is the
   * thing most worth reading. `handoff.ts` shortens the LIST for display and
   * still reports the true number.
   */
  readonly status: readonly string[]
  /** `git diff --stat HEAD`'s summary line, or null when the tree is clean. */
  readonly diffstat: string | null
}

export type Git = {
  identity(): Promise<GitIdentity>
  /** Null when `dir` is not a git working tree, or git is unavailable. */
  facts(dir: string): Promise<GitFacts | null>
}

/** Enough history to recognise where you were; not so much it stops being read. */
export const RECENT_COMMITS = 10

const TIMEOUT_MS = 5_000

type RunGit = (args: readonly string[], cwd?: string) => Promise<string | null>

/** Spawns the real `git`. Null on any failure — see the module note. */
function execGit(): RunGit {
  return (args, cwd) =>
    new Promise((resolve) => {
      execFile('git', [...args], { cwd, timeout: TIMEOUT_MS, maxBuffer: 4 * 1024 * 1024 }, (error, stdout) => {
        resolve(error ? null : stdout.trim())
      })
    })
}

function lines(text: string | null, cap: number): string[] {
  if (text === null || text.length === 0) return []
  return text.split('\n').slice(0, cap)
}

export function createGit(run: RunGit = execGit()): Git {
  return {
    async identity() {
      // `--get` rather than reading a file: it honours the whole precedence
      // chain (system, global, local, includes) that the human already set up.
      const [name, email] = await Promise.all([
        run(['config', '--get', 'user.name']),
        run(['config', '--get', 'user.email']),
      ])
      return {
        name: name && name.length > 0 ? name : null,
        email: email && email.length > 0 ? email : null,
      }
    },

    async facts(dir) {
      // The gate: not a work tree (or no git) means there is nothing to report,
      // and the handoff simply omits the section rather than apologising.
      const inside = await run(['rev-parse', '--is-inside-work-tree'], dir)
      if (inside !== 'true') return null

      const [branch, log, status, diff] = await Promise.all([
        run(['rev-parse', '--abbrev-ref', 'HEAD'], dir),
        run(['log', `-${RECENT_COMMITS}`, '--pretty=format:%h %s'], dir),
        run(['status', '--porcelain'], dir),
        run(['diff', '--stat', 'HEAD'], dir),
      ])

      // A fresh repo has no HEAD, so `rev-parse` says "HEAD" and `log` fails.
      // Both degrade to absent rather than to a wrong answer.
      const diffLines = lines(diff, Number.MAX_SAFE_INTEGER)
      return {
        branch: branch && branch !== 'HEAD' ? branch : null,
        commits: lines(log, RECENT_COMMITS),
        status: lines(status, Number.MAX_SAFE_INTEGER),
        diffstat: diffLines.length > 0 ? (diffLines[diffLines.length - 1] ?? null) : null,
      }
    },
  }
}
