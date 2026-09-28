/**
 * The handoff note — `cli-spec.md` §12.
 *
 * A project you come back to after three weeks is a project whose state you
 * have forgotten. `down` is the one moment when everything needed to describe
 * that state is still true and still reachable: the repository is on disk and
 * the dev container — with the agent's own session in it — is still running.
 * Ten seconds later the container is gone and the second half is unrecoverable.
 * So the note is written THERE, on the way down, and nowhere else.
 *
 * Two sources, and they fail independently:
 *
 *   - THE REPOSITORIES, from `ctx.git`. Free, instant, and true whether or not
 *     anyone ever ran an agent here: branch, recent commits, what is still
 *     uncommitted. `work/` may hold several, so each is walked and
 *     reported; a project with none says so.
 *   - THE AGENT'S OWN ACCOUNT, from `claude -p --continue` run inside the dev
 *     container. This is the half that knows what was being ATTEMPTED, which no
 *     amount of git archaeology recovers.
 *
 * BEST-EFFORT IS THE CONTRACT. Every way this can fail — no container, no
 * agent, no session to continue, no credentials, a timeout, a read-only disk —
 * degrades to a smaller note or to no note at all. None of them fails the
 * `down`. A stop that refused because it could not write a memo would be a
 * worse tool than one that never wrote memos, and the user asked for a stop.
 *
 * The file is APPENDED, never overwritten. A trivial "just said hello" session,
 * asked to summarise itself, honestly reports that nothing happened — and a
 * note that replaced the substantive entry above it with that would destroy
 * real history for no reason: `.bardolier/` sits above `work/` and is inside no
 * repository, so there is no git history underneath to fall back on. Each
 * `down` adds one entry; none is ever rewritten or dropped.
 */

import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Context } from './context.ts'
import type { GitFacts } from './git.ts'
import { entries, workDir, WORK_DIR } from './layout.ts'
import { devContainerName } from './naming.ts'
import type { ProjectManifest } from './model/project.ts'

/** Where the note lives, relative to the project directory. */
export const HANDOFF_DIR = '.bardolier'
export const HANDOFF_FILENAME = 'handoff.md'

/**
 * How long the agent gets to answer before the stop carries on without it.
 *
 * Generous enough for a real summary, short enough that a hung or
 * unauthenticated agent cannot hold a `down` open. On expiry the note is
 * written with its repository half and a line saying the other half timed out —
 * never silently truncated, because a section that is quietly missing reads as
 * "nothing was happening".
 */
export const SUMMARY_TIMEOUT_MS = 90_000

/**
 * How many changed paths the note LISTS. A handoff enumerating 400 files helps
 * nobody, but the count above the list is always the true one — the truncation
 * is presentation, and `GitFacts.status` stays complete so it cannot lie.
 */
export const MAX_STATUS_LISTED = 20

/**
 * What the agent is asked for.
 *
 * `--continue` is what makes this worth doing: it resumes the most recent
 * session in the container's working directory, so the answer comes from the
 * conversation that was actually happening rather than from a cold read of the
 * files. That only resolves to the right session because each project has its
 * own `$HOME` and therefore its own Claude config dir (`images.ts`) — every dev
 * container works in the same `/work`, so a shared one would file every
 * project's sessions together.
 */
export const SUMMARY_PROMPT = [
  'Write a handoff note for whoever resumes this project later — most likely you, weeks from now,',
  'with none of this conversation in mind.',
  'Cover three things and nothing else: what was being worked on, what state it is in right now,',
  'and the concrete next steps.',
  'Be specific about file and symbol names. Markdown, no preamble, no heading above level 3,',
  'under 250 words. If this session did no substantive work, say exactly that in one line.',
].join(' ')

export type Handoff = {
  /** Absolute path written. */
  readonly path: string
  /** True when the agent's own summary made it in. */
  readonly summarised: boolean
}

/** `claude -p --continue "<prompt>"` — the argv, in one place, for the test. */
export function summaryArgv(): string[] {
  return ['claude', '--print', '--continue', SUMMARY_PROMPT]
}

/**
 * Ask the agent in the still-running dev container to summarise itself.
 *
 * Returns null for every failure, which is all of them treated alike on
 * purpose — see the module note. A zero exit with empty output is also null: a
 * heading with nothing under it is worse than no heading.
 */
async function askAgent(ctx: Context, project: string): Promise<string | null> {
  const result = await ctx.docker.exec({
    container: devContainerName(project),
    argv: summaryArgv(),
    timeoutMs: SUMMARY_TIMEOUT_MS,
  })
  if (result.code !== 0) return null
  const text = result.stdout.trim()
  return text.length > 0 ? text : null
}

/** One repository under `work/`, as `git` sees it. */
type Repository = {
  readonly name: string
  readonly facts: GitFacts
}

/**
 * Every git working tree under `work/` — or `work/` itself, when the user
 * cloned into it rather than beside it.
 *
 * `work/` is the user's, so both shapes are real: one repository checked out as
 * `work/` and several sitting in it. Asking about `work/` first settles which,
 * and stops there — a repository's own subdirectories are its business, and
 * walking into them would turn a stop into a filesystem crawl. A directory that
 * is not a repository is skipped silently; a scratch folder is not a defect.
 */
async function repositories(ctx: Context, dir: string): Promise<Repository[]> {
  const work = workDir(dir)
  const itself = await ctx.git.facts(work)
  if (itself !== null) return [{ name: '', facts: itself }]

  const found: Repository[] = []
  for (const name of entries(work).sort()) {
    const path = join(work, name)
    try {
      if (!statSync(path).isDirectory()) continue
    } catch {
      continue
    }
    const facts = await ctx.git.facts(path)
    if (facts !== null) found.push({ name, facts })
  }
  return found
}

function repositoryFacts(facts: GitFacts): string[] {
  const lines: string[] = []
  lines.push(`- Branch: \`${facts.branch ?? '(detached or unborn)'}\``)
  lines.push(
    facts.status.length === 0
      ? '- Working tree: clean'
      : `- Working tree: ${facts.status.length} uncommitted path(s)`,
  )
  if (facts.diffstat !== null) lines.push(`- Since HEAD:${facts.diffstat.replace(/^\s*/, ' ')}`)

  if (facts.commits.length > 0) {
    lines.push('', '```')
    lines.push(...facts.commits)
    lines.push('```')
  }
  if (facts.status.length > 0) {
    lines.push('', 'Uncommitted:', '', '```')
    lines.push(...facts.status.slice(0, MAX_STATUS_LISTED))
    const hidden = facts.status.length - MAX_STATUS_LISTED
    if (hidden > 0) lines.push(`… and ${hidden} more`)
    lines.push('```')
  }
  return lines
}

function repositorySection(repos: readonly Repository[]): string[] {
  if (repos.length === 0) {
    return ['### The repositories', '', `No git repositories under \`${WORK_DIR}/\`.`]
  }
  const lines = ['### The repositories']
  for (const repo of repos) {
    lines.push('', `#### ${WORK_DIR}/${repo.name}`.replace(/\/$/, ''), '', ...repositoryFacts(repo.facts))
  }
  return lines
}

/** Written once, the first time a project ever gets a note. */
function header(project: string): string {
  return [
    `# Handoff — ${project}`,
    '',
    'Written by `bardolier down`. Each stop appends an entry below — none is ever',
    'rewritten or removed; the newest is at the bottom.',
    '',
  ].join('\n')
}

/** One stop's entry — everything a single note used to hold, now under its own timestamp. */
function renderEntry(when: Date, summary: string | null, repos: readonly Repository[]): string {
  const lines = [`## ${when.toISOString()}`, '', '### Where the work was', '']
  lines.push(
    summary ??
      'No summary: there was no Claude Code session in the dev container to continue, ' +
        'or the agent could not be reached before the stop timed out.',
  )
  lines.push('', ...repositorySection(repos))
  return `${lines.join('\n')}\n`
}

export type HandoffRequest = {
  readonly manifest: ProjectManifest
  readonly dir: string
  /** False when the dev container is already down — then there is nobody to ask. */
  readonly devRunning: boolean
}

/**
 * Write the note. Returns null when nothing could be written at all, which is
 * information the caller reports and never raises.
 *
 * Ordering matters and is the whole reason this is called from `down` rather
 * than after it: the agent is asked while its container is still up.
 */
export async function writeHandoff(ctx: Context, request: HandoffRequest): Promise<Handoff | null> {
  const { manifest, dir, devRunning } = request

  const repos = await repositories(ctx, dir)
  const summary = devRunning ? await askAgent(ctx, manifest.name) : null

  const path = handoffPath(dir)
  const existing = existsSync(path)

  // Nothing to say and nobody said it — don't create a note for a project that
  // has never been a repository and has never run an agent. Once one exists,
  // every stop still appends: a trivial session's honest "nothing happened" is
  // itself worth recording, not a reason to drop the entry above it.
  if (repos.length === 0 && summary === null && !existing) return null

  try {
    mkdirSync(join(dir, HANDOFF_DIR), { recursive: true })
    const prefix = existing ? `${readFileSync(path, 'utf8').replace(/\n*$/, '\n')}\n---\n\n` : header(manifest.name)
    writeFileSync(path, prefix + renderEntry(ctx.now(), summary, repos))
    return { path, summarised: summary !== null }
  } catch {
    // A read-only or vanished SSD. The stop still succeeded; say nothing here
    // and let `down` report that the note is absent.
    return null
  }
}

/** Where the note WOULD be, for a caller that wants to mention it. */
export function handoffPath(dir: string): string {
  return join(dir, HANDOFF_DIR, HANDOFF_FILENAME)
}
