/**
 * The note `down` writes before the container it asks is gone.
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { devContainerName } from '../cli/src/naming.ts'
import { HANDOFF_DIR, HANDOFF_FILENAME, SUMMARY_PROMPT, summaryArgv } from '../cli/src/handoff.ts'
import { runDown } from '../cli/src/commands/down.ts'
import { validate } from '../cli/src/schema.ts'
import type { ExecResult } from '../cli/src/docker.ts'
import type { Git, GitFacts } from '../cli/src/git.ts'
import { createContext } from '../cli/src/context.ts'
import { manifest, ports, project, type Sandbox, sandboxes, stubDocker } from './helpers.ts'

const sandbox = sandboxes()

/**
 * Git facts a test can dictate, or a repo that is not one.
 *
 * `name`/`email` are `string | null` because that is what `GitIdentity`
 * promises: `createGit` normalises an unset OR EMPTY `git config` value to null
 * — which is not hypothetical, an empty `user.email =` line in a real
 * `~/.gitconfig` is exactly how a Mac ends up with a name and no address.
 */
function stubGit(facts: GitFacts | null, name: string | null = 'Mark', email: string | null = 'mark@example.com'): Git {
  return {
    identity: async () => ({ name, email }),
    facts: async () => facts,
  }
}

const SOME_FACTS: GitFacts = {
  branch: 'feature/parser',
  commits: ['abc1234 Teach the lexer about comments'],
  status: [' M src/lexer.ts'],
  diffstat: ' 1 file changed, 12 insertions(+)',
}

function context(box: Sandbox, options: Parameters<typeof createContext>[0] = {}) {
  return createContext({
    env: { BARDOLIER_ROOT: box.root },
    home: box.home,
    path: box.configPath,
    ports: { isFree: async () => true },
    ...options,
  })
}

// ── the handoff (§12) ────────────────────────────────────────────────────────
describe('the handoff note', () => {
  const answered = (stdout: string) => (): ExecResult => ({ code: 0, stdout, stderr: '' })

  async function stoppedProject(box: Sandbox, options: { exec?: () => ExecResult; git?: Git } = {}) {
    const docker = stubDocker({
      running: [devContainerName('myapp')],
      ...(options.exec ? { exec: options.exec } : {}),
    })
    const ctx = context(box, { docker, git: options.git ?? stubGit(SOME_FACTS) })
    box.writeProject('myapp', manifest('myapp'))
    // `work/` is where the repositories are (phase 19); the note walks it.
    mkdirSync(join(box.path('myapp'), 'work', 'lexer'), { recursive: true })
    return { docker, ctx }
  }

  test('is written before the containers go, because the session dies with them', async () => {
    const box = sandbox()
    const { docker, ctx } = await stoppedProject(box, { exec: answered('### Next steps\nFinish the lexer.') })

    await runDown(ctx, 'myapp')

    assert.deepEqual(
      docker.calls.map((call) => call.kind),
      ['exec', 'down'],
      'asking after `compose down` would be asking nobody',
    )
  })

  test('carries the agent’s own summary when it answers', async () => {
    const box = sandbox()
    const { ctx } = await stoppedProject(box, { exec: answered('### Next steps\nFinish the lexer.') })

    const result = await runDown(ctx, 'myapp')

    assert.ok(validate('down', result).valid, 'down output must still match its schema')
    assert.equal(result.handoff_summarised, true)
    const note = box.read('myapp', HANDOFF_DIR, HANDOFF_FILENAME) ?? ''
    assert.match(note, /Finish the lexer\./)
    assert.match(note, /feature\/parser/, 'the repository half is there too')
    assert.match(note, /abc1234 Teach the lexer about comments/)
  })

  test('walks work/*/ and reports each repository it finds', async () => {
    const box = sandbox()
    // `work/` itself is not a repo here; the clones sit in it. Only a
    // path-aware stub can tell those two shapes apart.
    const clones: Git = {
      identity: async () => ({ name: 'Mark', email: 'mark@example.com' }),
      facts: async (dir) => (/work\/(lexer|parser)$/.test(dir) ? SOME_FACTS : null),
    }
    const { ctx } = await stoppedProject(box, { exec: answered('### Next steps\nFinish the lexer.'), git: clones })
    mkdirSync(join(box.path('myapp'), 'work', 'parser'), { recursive: true })
    // Not a directory, and so not a repository: `work/` is the user's.
    writeFileSync(join(box.path('myapp'), 'work', 'notes.md'), '# scratch\n')

    await runDown(ctx, 'myapp')

    const note = box.read('myapp', HANDOFF_DIR, HANDOFF_FILENAME) ?? ''
    assert.match(note, /#### work\/lexer/)
    assert.match(note, /#### work\/parser/)
    assert.ok(!note.includes('notes.md'), 'a loose file is not a repository')
  })

  test('a repository cloned AS work/ is the one repository, not zero', async () => {
    // `git clone … work` is as ordinary as cloning beside it, and a note that
    // said "no repositories" there would be wrong about the whole project.
    const box = sandbox()
    const { ctx } = await stoppedProject(box, { exec: answered('### Next steps\nShip it.') })

    await runDown(ctx, 'myapp')

    const note = box.read('myapp', HANDOFF_DIR, HANDOFF_FILENAME) ?? ''
    assert.match(note, /#### work$/m)
    assert.match(note, /feature\/parser/)
  })

  test('a project with no repository says so rather than saying nothing', async () => {
    const box = sandbox()
    const { ctx } = await stoppedProject(box, {
      exec: answered('### Next steps\nStill deciding.'),
      git: stubGit(null),
    })

    await runDown(ctx, 'myapp')

    const note = box.read('myapp', HANDOFF_DIR, HANDOFF_FILENAME) ?? ''
    assert.match(note, /No git repositories under `work\/`\./)
    assert.match(note, /Still deciding\./, 'the agent half survives on its own')
  })

  test('asks with --continue, so the answer comes from the session that happened', () => {
    assert.deepEqual(summaryArgv(), ['claude', '--print', '--continue', SUMMARY_PROMPT])
  })

  test('an agent that cannot answer costs the note its summary, not the stop', async () => {
    const box = sandbox()
    // The real shape of "not logged in": a non-zero exit with output on stderr.
    const { ctx } = await stoppedProject(box, {
      exec: () => ({ code: 1, stdout: 'Not logged in · Please run /login', stderr: '' }),
    })

    const result = await runDown(ctx, 'myapp')

    assert.equal(result.state, 'stopped', 'the stop must succeed regardless')
    assert.equal(result.handoff_summarised, false)
    const note = box.read('myapp', HANDOFF_DIR, HANDOFF_FILENAME) ?? ''
    assert.ok(!note.includes('Not logged in'), 'a refusal is not a summary')
    assert.match(note, /No summary/)
    assert.match(note, /feature\/parser/, 'the repository half survives on its own')
  })

  test('a zero exit with nothing to say is not a summary either', async () => {
    const box = sandbox()
    const { ctx } = await stoppedProject(box, { exec: answered('   \n  ') })

    const result = await runDown(ctx, 'myapp')
    assert.equal(result.handoff_summarised, false)
  })

  test('a stopped project is not asked at all', async () => {
    const box = sandbox()
    box.writeProject('myapp', manifest('myapp'))
    // Nothing running: there is no container to exec into.
    const docker = stubDocker({ exec: answered('should never be asked') })
    const ctx = context(box, { docker, git: stubGit(SOME_FACTS) })
    mkdirSync(join(box.path('myapp'), 'work', 'lexer'), { recursive: true })

    await runDown(ctx, 'myapp')

    assert.ok(!docker.calls.some((call) => call.kind === 'exec'))
    const note = box.read('myapp', HANDOFF_DIR, HANDOFF_FILENAME) ?? ''
    assert.match(note, /No summary/)
  })

  test('--no-handoff writes nothing and asks nobody', async () => {
    const box = sandbox()
    const { docker, ctx } = await stoppedProject(box, { exec: answered('a summary') })

    const result = await runDown(ctx, 'myapp', { noHandoff: true })

    assert.equal(result.handoff_path, null)
    assert.ok(!docker.calls.some((call) => call.kind === 'exec'))
    assert.ok(!box.exists('myapp', HANDOFF_DIR, HANDOFF_FILENAME))
  })

  test('a project that is neither a repo nor has an agent gets no empty file', async () => {
    const box = sandbox()
    const { ctx } = await stoppedProject(box, { git: stubGit(null) })

    const result = await runDown(ctx, 'myapp')

    assert.equal(result.handoff_path, null)
    assert.ok(!box.exists('myapp', HANDOFF_DIR), 'no directory either')
  })

  test('a later stop with nothing new to say still appends, not skips', async () => {
    const box = sandbox()
    const { ctx } = await stoppedProject(box, { git: stubGit(null) })
    const dir = box.path('myapp', HANDOFF_DIR)
    mkdirSync(dir, { recursive: true })
    writeFileSync(box.path('myapp', HANDOFF_DIR, HANDOFF_FILENAME), 'entry from three weeks ago')

    const result = await runDown(ctx, 'myapp')

    assert.ok(result.handoff_path, 'once a note exists, every stop still adds to it')
    const note = box.read('myapp', HANDOFF_DIR, HANDOFF_FILENAME) ?? ''
    assert.match(note, /entry from three weeks ago/, 'a quiet session must not erase what came before')
    assert.match(note, /No summary/)
  })

  test('delete never writes one — the directory is about to go', async () => {
    const box = sandbox()
    const { docker, ctx } = await stoppedProject(box, { exec: answered('a summary') })
    const { runDelete } = await import('../cli/src/commands/delete.ts')

    await runDelete(ctx, { name: 'myapp', force: true, purge: false, json: true })

    assert.ok(!docker.calls.some((call) => call.kind === 'exec'))
  })

  test('the note accumulates entries — nothing is ever overwritten', async () => {
    const box = sandbox()
    const { ctx } = await stoppedProject(box, { exec: answered('### First\nOne.') })
    await runDown(ctx, 'myapp')

    const second = await stoppedProject(box, { exec: answered('### Second\nTwo.') })
    await runDown(second.ctx, 'myapp')

    const note = box.read('myapp', HANDOFF_DIR, HANDOFF_FILENAME) ?? ''
    assert.match(note, /One\./, 'a later, quieter session must not erase an earlier substantive one')
    assert.match(note, /Two\./)
    assert.ok(note.indexOf('One.') < note.indexOf('Two.'), 'newest entry is appended at the bottom')
  })
})
