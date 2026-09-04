/**
 * Phase 9 — the agent in the container and the memory of what it did. Phase 8
 * built containers an agent could work in; it did not put the agent in them,
 * give it a place to keep a login, let it commit as the human, let a browser
 * reach what it served, or remember any of it after the stop.
 *   - THE AGENT IS IN THE IMAGE and outside `$HOME`, a mounted volume that
 *     would copy anything left under it once per project.
 *   - `$HOME` IS A VOLUME, one per project, at the path `CONTAINER_HOME` and
 *     all three Dockerfiles agree on. `down` removes the container, so a home
 *     in its writable layer loses the login and the history every time.
 *   - THE HOST IS LENT, NOT COPIED: the generated file names the variables and
 *     carries no values, so it is identical with and without them.
 *   - THE DEV SERVER IS REACHABLE — §9's one exception to "publishes nothing",
 *     including for projects predating the field.
 *   - THE HANDOFF IS BEST-EFFORT AND EARLY: written before the containers go,
 *     because the session dies with them, and never able to fail the stop.
 */

import { test, describe, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { parse as parseYaml } from 'yaml'

import { CONTAINER_HOME, baseImages } from '../cli/src/images.ts'
import { PASSTHROUGH_ENV, renderCompose } from '../cli/src/compose.ts'
import { ARCHETYPE_APP_PORT } from '../cli/src/model/archetype.ts'
import { devContainerName, homeVolumeName } from '../cli/src/naming.ts'
import { assignedPorts } from '../cli/src/allocator.ts'
import { HANDOFF_DIR, HANDOFF_FILENAME, SUMMARY_PROMPT, summaryArgv } from '../cli/src/handoff.ts'
import { runNew } from '../cli/src/commands/new.ts'
import { runUp } from '../cli/src/commands/up.ts'
import { runDown } from '../cli/src/commands/down.ts'
import { validate } from '../cli/src/schema.ts'
import { collectStatus } from '../cli/src/commands/status.ts'
import type { ExecResult } from '../cli/src/docker.ts'
import type { Git, GitFacts } from '../cli/src/git.ts'
import { makeSandbox, manifest, stubDocker, type Sandbox } from './helpers.ts'
import { createContext } from '../cli/src/context.ts'

// ── scaffolding ──────────────────────────────────────────────────────────────

const boxes: Sandbox[] = []
function sandbox(): Sandbox {
  const box = makeSandbox()
  boxes.push(box)
  return box
}
afterEach(() => {
  while (boxes.length > 0) boxes.pop()?.cleanup()
})

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
    env: { BARDOLIER_SSD_ROOT: box.root },
    home: box.home,
    path: box.configPath,
    ports: { isFree: async () => true },
    ...options,
  })
}

/** The Dockerfile text of a base image. */
function dockerfile(image: string): string {
  const definition = baseImages().find((candidate) => candidate.image === image)
  assert.ok(definition?.dockerfile, `${image} has no Dockerfile`)
  return readFileSync(definition.dockerfile, 'utf8')
}

// ── the agent is in the image (§4.3) ─────────────────────────────────────────

describe('Claude Code is part of every base image', () => {
  test('all three install it, pinned and verified', () => {
    for (const { image } of baseImages()) {
      const text = dockerfile(image)
      assert.match(text, /ARG CLAUDE_CODE_VERSION=\d+\.\d+\.\d+/, `${image} must pin a version`)
      assert.match(text, /sha256sum -c -/, `${image} must verify the download`)
      assert.match(text, /claude --version/, `${image} must prove it runs at build time`)
    }
  })

  test('it is installed OUTSIDE $HOME, which is a per-project volume', () => {
    for (const { image } of baseImages()) {
      const text = dockerfile(image)
      // The whole reason for not using the installer's default location: a
      // 236MB binary under $HOME would be copied into every project's volume.
      assert.match(text, /-o \/usr\/local\/bin\/claude/, `${image} must install to a system path`)
      assert.ok(
        !/-o .*\$\{?HOME/.test(text),
        `${image} must not install the agent into the mounted home`,
      )
    }
  })

  test('every Dockerfile sets $HOME to the path compose mounts (CONTAINER_HOME)', () => {
    for (const { image } of baseImages()) {
      // One constant, three readers. A Dockerfile that disagreed would still
      // work and would silently lose the login on every `down`, which is
      // exactly the failure that is hard to notice and worth a test.
      assert.match(dockerfile(image), new RegExp(`ENV HOME=${CONTAINER_HOME}\\b`), `${image}`)
    }
  })
})

// ── $HOME survives the stop (§9) ─────────────────────────────────────────────

describe('the dev container home', () => {
  test('is mounted from a per-project named volume', () => {
    const doc = parseYaml(renderCompose({ manifest: manifest('myapp'), catalogue: null })) as Record<string, any>
    assert.ok(doc.services.dev.volumes.includes(`${homeVolumeName('myapp')}:${CONTAINER_HOME}`))
  })

  test('is the project’s own, labelled so the orphan scan can attribute it', () => {
    const doc = parseYaml(renderCompose({ manifest: manifest('myapp'), catalogue: null })) as Record<string, any>
    const volume = doc.volumes[homeVolumeName('myapp')]
    assert.equal(volume.labels['bardolier.project'], 'myapp')
    assert.equal(volume.labels['bardolier.role'], 'home')
    // NOT external: unlike the shared toolchain cache, this one is created and
    // owned by this project's Compose (images.ts).
    assert.equal(volume.external, undefined)
  })

  test('two projects never share one', () => {
    assert.notEqual(homeVolumeName('alpha'), homeVolumeName('beta'))
  })
})

// ── the host is lent, not copied (§9) ────────────────────────────────────────

describe('what the dev container inherits from the Mac', () => {
  test('the generated file names the variables and carries no values', () => {
    const rendered = renderCompose({ manifest: manifest('myapp'), catalogue: null })
    for (const name of PASSTHROUGH_ENV) {
      assert.match(rendered, new RegExp(`- ${name}$`, 'm'), `${name} must be passed through by name`)
      assert.ok(!rendered.includes(`${name}=`), `${name} must not be given a value in the file`)
    }
  })

  test('a credential is never written into the compose file', () => {
    // The determinism rule (§9) doing real work: the same manifest renders the
    // same bytes whether or not this Mac is holding a token.
    const rendered = renderCompose({ manifest: manifest('myapp'), catalogue: null })
    assert.ok(!rendered.includes('${'), 'no interpolation — an absent token must stay absent, not become empty')
  })

  test('up lends the host git identity so a commit in the container is attributable', async () => {
    const box = sandbox()
    const docker = stubDocker({ startsAs: [devContainerName('myapp')] })
    const ctx = context(box, { docker, git: stubGit(null, 'Ada', 'ada@example.com') })
    await runNew(ctx, { name: 'myapp', archetype: 'web', services: undefined })
    await runUp(ctx, { name: 'myapp', noShell: true })

    const up = docker.calls.find((call) => call.kind === 'up')
    assert.ok(up?.kind === 'up')
    assert.equal(up.target.env?.GIT_AUTHOR_NAME, 'Ada')
    assert.equal(up.target.env?.GIT_COMMITTER_EMAIL, 'ada@example.com')
  })

  test('a host with no git identity lends nothing rather than an empty name', async () => {
    const box = sandbox()
    const docker = stubDocker({ startsAs: [devContainerName('myapp')] })
    const ctx = context(box, { docker, git: stubGit(null, null, null) })
    await runNew(ctx, { name: 'myapp', archetype: 'web', services: undefined })
    await runUp(ctx, { name: 'myapp', noShell: true })

    const up = docker.calls.find((call) => call.kind === 'up')
    assert.ok(up?.kind === 'up')
    assert.equal(up.target.env?.GIT_AUTHOR_NAME, undefined, 'an empty identity is no identity')
  })
})

// ── the dev server (§9) ──────────────────────────────────────────────────────

describe('the dev-server port', () => {
  test('a web project is assigned one at creation and publishes it', async () => {
    const box = sandbox()
    const ctx = context(box)
    const created = await runNew(ctx, { name: 'site', archetype: 'web', services: undefined })
    assert.ok(validate('new', created).valid)

    const compose = box.read('site', 'docker-compose.yml') ?? ''
    const doc = parseYaml(compose) as Record<string, any>
    assert.deepEqual(doc.services.dev.ports, [`3000:${ARCHETYPE_APP_PORT.web}`])
    // Fixed inside, variable outside: the server's own config never changes.
    assert.ok(doc.services.dev.environment.includes(`PORT=${ARCHETYPE_APP_PORT.web}`))
  })

  test('an archetype that serves nothing publishes nothing', async () => {
    const box = sandbox()
    const ctx = context(box)
    await runNew(ctx, { name: 'app', archetype: 'ios', services: undefined })

    const doc = parseYaml(box.read('app', 'docker-compose.yml') ?? '') as Record<string, any>
    assert.equal(doc.services.dev.ports, undefined)
    assert.ok(!doc.services.dev.environment.some((entry: string) => entry.startsWith('PORT=')))
  })

  test('a second web project lands in the band rather than colliding', async () => {
    const box = sandbox()
    const ctx = context(box)
    await runNew(ctx, { name: 'one', archetype: 'web', services: undefined })
    await runNew(ctx, { name: 'two', archetype: 'web', services: undefined })

    const ports = assignedPorts(ctx.config)
    assert.equal([...ports.keys()].filter((port) => port >= 3000 && port < 3100).length, 2)
    assert.notEqual(
      parseYaml(box.read('one', 'project.yml') ?? '').app_port,
      parseYaml(box.read('two', 'project.yml') ?? '').app_port,
    )
  })

  test('a project that predates the field is assigned one on its next up', async () => {
    const box = sandbox()
    // Written without app_port — what every existing web project looks like.
    box.writeProject('legacy', manifest('legacy'))
    const docker = stubDocker({ startsAs: [devContainerName('legacy')] })
    const ctx = context(box, { docker })

    const result = await runUp(ctx, { name: 'legacy', noShell: true })

    assert.equal(result.app_port, 3000)
    assert.equal(result.app_url, 'http://localhost:3000')
    // Persisted, because §5 says a port is decided once and then kept.
    assert.equal(parseYaml(box.read('legacy', 'project.yml') ?? '').app_port, 3000)
  })

  test('status reports the URL rather than leaving the app to build one', async () => {
    const box = sandbox()
    const ctx = context(box)
    await runNew(ctx, { name: 'site', archetype: 'web', services: undefined })
    await runNew(ctx, { name: 'app', archetype: 'ios', services: undefined })

    const status = await collectStatus(ctx)
    assert.ok(validate('status', status).valid, 'status must still match its schema')
    const site = status.projects.find((p) => p.name === 'site')
    const app = status.projects.find((p) => p.name === 'app')
    assert.equal(site?.app_url, 'http://localhost:3000')
    assert.equal(app?.app_port, null, 'an ios project has no dev server')
    assert.equal(app?.app_url, null)
  })
})

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

    await runDelete(ctx, { name: 'myapp', force: true, keepData: true, purge: false, json: true })

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
