/**
 * Phase 4 — shell, volumes, down-all, eject. No SSD, no daemon: `stubDevice`
 * answers a scripted `lsof` and records whether `diskutil eject` was reached,
 * which is what makes the eject contract testable with no disk to unmount.
 *   - `shell` RESOLVES and never spawns; a stopped project is PROJECT_STOPPED.
 *   - an orphan is derived from the MANIFESTS: still attached is never offered,
 *     a detached service's volume always is.
 *   - `volumes rm` confirms, and refuses VOLUME_IN_USE before asking Docker.
 *   - `eject` stops, checks holders, unmounts — and refuses with them named
 *     rather than forcing.
 */

import { test, describe, afterEach } from 'node:test'
import assert from 'node:assert/strict'

import { BardolierError } from '../cli/src/errors.ts'
import { validate } from '../cli/src/schema.ts'
import { formatBytes, scanVolumes } from '../cli/src/volumes.ts'
import { parseDockerSize } from '../cli/src/docker.ts'
import { createSsdDevice, isRuntimeHolder, isSystemHolder, parseDissenter, parseLsof } from '../cli/src/device.ts'
import { runNew } from '../cli/src/commands/new.ts'
import { runUp } from '../cli/src/commands/up.ts'
import { runServiceRemove } from '../cli/src/commands/service.ts'
import { runDelete } from '../cli/src/commands/delete.ts'
import { collectStatus } from '../cli/src/commands/status.ts'
import { runShell } from '../cli/src/commands/shell.ts'
import { collectOrphanedVolumes, runVolumeRemove } from '../cli/src/commands/volumes.ts'
import { runDownAll, runEject } from '../cli/src/commands/ssd.ts'
import { containingVolume } from '../cli/src/projects.ts'
import type { Context } from '../cli/src/context.ts'
import {
  holder,
  makeContext,
  makeSandbox,
  stubConfirm,
  stubDevice,
  stubDocker,
  type Sandbox,
  type StubDevice,
  type StubDocker,
} from './helpers.ts'

const sandboxes: Sandbox[] = []
function sandbox(): Sandbox {
  const created = makeSandbox()
  sandboxes.push(created)
  return created
}
afterEach(() => {
  while (sandboxes.length > 0) sandboxes.pop()?.cleanup()
})

/** The labels the generated compose file puts on a service's volume (§9). */
function labels(project: string, service: string) {
  return { 'bardolier.project': project, 'bardolier.service': service }
}

/** A project on disk, created the way a user would. */
async function project(ctx: Context, name: string, services?: string): Promise<void> {
  await runNew(ctx, { name, archetype: 'web', services })
}

// ── shell (§6, Shell) ─────────────────────────────────────────────────────────

describe('shell (cli-spec.md §6, Shell)', () => {
  test('resolves the dev container and returns the exec argv', async () => {
    const box = sandbox()
    const docker = stubDocker({ running: ['bardolier-alpha'] })
    const ctx = makeContext(box, docker)
    await project(ctx, 'alpha')

    const output = await runShell(ctx, 'alpha')
    assert.deepEqual(output, {
      project: 'alpha',
      container: 'bardolier-alpha',
      exec: ['docker', 'exec', '-it', 'bardolier-alpha', 'bash'],
      workdir: '/work',
    })
    assert.ok(validate('shell', output).valid)
  })

  test('--root swaps to `docker exec -u root`, same container, same checks (phase 14)', async () => {
    const box = sandbox()
    const docker = stubDocker({ running: ['bardolier-alpha'] })
    const ctx = makeContext(box, docker)
    await project(ctx, 'alpha')

    const output = await runShell(ctx, 'alpha', { root: true })
    assert.deepEqual(output.exec, ['docker', 'exec', '-u', 'root', '-it', 'bardolier-alpha', 'bash'])
    assert.ok(validate('shell', output).valid)
  })

  test('a stopped project is PROJECT_STOPPED with --root too', async () => {
    const box = sandbox()
    const docker = stubDocker({ running: [] })
    const ctx = makeContext(box, docker)
    await project(ctx, 'alpha')

    await assert.rejects(
      () => runShell(ctx, 'alpha', { root: true }),
      (error: unknown) => error instanceof BardolierError && error.code === 'PROJECT_STOPPED',
    )
  })

  test('spawns nothing — the daemon is only ever asked what is running', async () => {
    const box = sandbox()
    const docker = stubDocker({ running: ['bardolier-alpha'] })
    const ctx = makeContext(box, docker)
    await project(ctx, 'alpha')

    await runShell(ctx, 'alpha')
    assert.deepEqual(docker.calls, [], 'shell mutated Docker; it must only resolve a name')
  })

  test('a stopped project is PROJECT_STOPPED, not a silent start', async () => {
    const box = sandbox()
    const docker = stubDocker({ running: [] })
    const ctx = makeContext(box, docker)
    await project(ctx, 'alpha')

    await assert.rejects(
      () => runShell(ctx, 'alpha'),
      (error: unknown) => error instanceof BardolierError && error.code === 'PROJECT_STOPPED',
    )
    assert.deepEqual(docker.calls, [], 'a refused shell started something')
  })

  test('a project whose services are up but whose dev container is not is still PROJECT_STOPPED', async () => {
    const box = sandbox()
    const ctx = makeContext(box, stubDocker({ running: ['bardolier-alpha-postgres'] }))
    await project(ctx, 'alpha', 'postgres')

    await assert.rejects(
      () => runShell(ctx, 'alpha'),
      (error: unknown) => error instanceof BardolierError && error.code === 'PROJECT_STOPPED',
    )
  })

  test('an unreachable daemon is DOCKER_UNAVAILABLE, not a false "stopped"', async () => {
    const box = sandbox()
    const ctx = makeContext(box, stubDocker({ available: true }))
    await project(ctx, 'alpha')
    const offline = makeContext(box, stubDocker({ available: false }))

    await assert.rejects(
      () => runShell(offline, 'alpha'),
      (error: unknown) => error instanceof BardolierError && error.code === 'DOCKER_UNAVAILABLE',
    )
  })

  test('an unknown project is PROJECT_NOT_FOUND', async () => {
    const ctx = makeContext(sandbox(), stubDocker({ running: [] }))
    await assert.rejects(
      () => runShell(ctx, 'ghost'),
      (error: unknown) => error instanceof BardolierError && error.code === 'PROJECT_NOT_FOUND',
    )
  })
})

// ── orphan derivation (§6, Volumes / disk; §7) ────────────────────────────────

describe('orphaned volumes (cli-spec.md §6, §7)', () => {
  test('a volume a project still attaches is not an orphan', async () => {
    const box = sandbox()
    const docker = stubDocker({ volumes: [{ name: 'alpha_pgdata', labels: labels('alpha', 'postgres'), size_bytes: 20971520 }] })
    const ctx = makeContext(box, docker)
    await project(ctx, 'alpha', 'postgres')

    const output = await collectOrphanedVolumes(ctx)
    assert.deepEqual(output.orphaned, [])
    assert.equal(output.total_bytes, 0)
  })

  test('detaching the service makes its volume an orphan, attributed and sized', async () => {
    const box = sandbox()
    const docker = stubDocker({ volumes: [{ name: 'alpha_pgdata', labels: labels('alpha', 'postgres'), size_bytes: 20971520 }] })
    const ctx = makeContext(box, docker)
    await project(ctx, 'alpha', 'postgres')

    await runServiceRemove(ctx, { project: 'alpha', service: 'postgres' })

    const output = await collectOrphanedVolumes(ctx)
    assert.deepEqual(output.orphaned, [
      { name: 'alpha_pgdata', size_bytes: 20971520, size_human: '20 MB', last_project: 'alpha' },
    ])
    assert.equal(output.total_human, '20 MB')
    assert.ok(validate('volumes-orphaned', output).valid)
  })

  test('deleting the project with --keep-data leaves the same orphan behind', async () => {
    const box = sandbox()
    const docker = stubDocker({ volumes: [{ name: 'alpha_pgdata', labels: labels('alpha', 'postgres'), size_bytes: 1024 }] })
    const ctx = makeContext(box, docker)
    await project(ctx, 'alpha', 'postgres')

    const deleted = await runDelete(ctx, { name: 'alpha', force: true, keepData: false, purge: false, json: true })
    assert.deepEqual(deleted.kept_volumes, ['alpha_pgdata', 'bardolier-alpha-home'])

    const output = await collectOrphanedVolumes(ctx)
    assert.deepEqual(output.orphaned.map((v) => v.name), ['alpha_pgdata'])
    assert.equal(output.orphaned[0]?.last_project, 'alpha', 'the label is what attributes an orphan to a dead project')
  })

  test('a volume that is not ours is never listed, labelled or not', async () => {
    const box = sandbox()
    const docker = stubDocker({ volumes: ['someone-elses-data', { name: 'ci_cache', labels: { 'other.tool': 'yes' } }] })
    const ctx = makeContext(box, docker)
    await project(ctx, 'alpha')

    assert.deepEqual((await collectOrphanedVolumes(ctx)).orphaned, [])
  })

  test('an attachment the catalogue no longer defines still protects its volume', async () => {
    // The volume NAME cannot be resolved without a catalogue entry, so only the
    // labels can save it. Listing it would offer live data for deletion.
    const box = sandbox()
    const docker = stubDocker({ volumes: [{ name: 'alpha_kafkadata', labels: labels('alpha', 'kafka'), size_bytes: 4096 }] })
    const ctx = makeContext(box, docker)
    await project(ctx, 'alpha')
    box.writeProject('alpha', {
      name: 'alpha',
      archetype: 'web',
      base_image: 'bardolier-web',
      services: { kafka: { host_port: 9092 } },
      created: '2026-08-19T10:00:00.000Z',
    })

    assert.deepEqual((await collectOrphanedVolumes(ctx)).orphaned, [])
  })

  test('an unmeasurable volume reports unknown rather than zero bytes dressed up', async () => {
    const box = sandbox()
    const docker = stubDocker({ volumes: [{ name: 'ghost_pgdata', labels: labels('ghost', 'postgres') }] })
    const ctx = makeContext(box, docker)
    await project(ctx, 'alpha')

    const [orphan] = (await collectOrphanedVolumes(ctx)).orphaned
    assert.equal(orphan?.size_human, 'unknown')
    assert.equal(orphan?.size_bytes, 0)
  })

  test('with the SSD unmounted it refuses rather than calling everything an orphan', async () => {
    const box = sandbox()
    const docker = stubDocker({ volumes: [{ name: 'alpha_pgdata', labels: labels('alpha', 'postgres') }] })
    const ctx = makeContext(box, docker, { env: { BARDOLIER_ROOT: `${box.root}-gone` } })

    await assert.rejects(
      () => collectOrphanedVolumes(ctx),
      (error: unknown) => error instanceof BardolierError && error.code === 'SSD_NOT_MOUNTED',
    )
  })

  test('an unreadable manifest refuses too — its attachments are unknowable', async () => {
    const box = sandbox()
    const docker = stubDocker({ volumes: [{ name: 'alpha_pgdata', labels: labels('alpha', 'postgres') }] })
    const ctx = makeContext(box, docker)
    box.writeProject('broken', 'not: [valid')

    await assert.rejects(
      () => collectOrphanedVolumes(ctx),
      (error: unknown) => error instanceof BardolierError && error.code === 'CONFIG_INVALID',
    )
  })

  test('status carries the same orphans (§7) and never fails for them', async () => {
    const box = sandbox()
    const docker = stubDocker({ volumes: [{ name: 'old_pgdata', labels: labels('old', 'postgres'), size_bytes: 512 }] })
    const ctx = makeContext(box, docker)
    await project(ctx, 'alpha')

    const status = await collectStatus(ctx)
    assert.deepEqual(status.orphaned_volumes, (await collectOrphanedVolumes(ctx)).orphaned)
    assert.ok(validate('status', status).valid)

    // Same disk, no daemon: status still answers, with nothing invented.
    const offline = await collectStatus(makeContext(box, stubDocker({ available: false })))
    assert.deepEqual(offline.orphaned_volumes, [])
  })

  test('sizes are only measured when there is something to size', async () => {
    const box = sandbox()
    let measured = 0
    const docker = stubDocker({ volumes: [{ name: 'alpha_pgdata', labels: labels('alpha', 'postgres'), size_bytes: 1 }] })
    const counting = { ...docker, volumeSizes: async () => (measured++, docker.volumeSizes()) }
    const ctx = makeContext(box, counting)
    await project(ctx, 'alpha', 'postgres')

    await scanVolumes(ctx)
    assert.equal(measured, 0, 'nothing was orphaned, so `docker system df` should not have been paid for')
  })

  test('formats bytes the way §7 writes them', () => {
    assert.equal(formatBytes(20971520), '20 MB')
    assert.equal(formatBytes(0), '0 B')
    assert.equal(formatBytes(1536), '1.5 KB')
  })

  test('reads back the human sizes Docker prints', () => {
    assert.equal(parseDockerSize('110.7MB'), 110700000)
    assert.equal(parseDockerSize('0B'), 0)
    assert.equal(parseDockerSize('N/A'), null)
  })
})

// ── volumes rm (§6) ───────────────────────────────────────────────────────────

describe('volumes rm (cli-spec.md §6)', () => {
  /** A disk with one project and one volume nothing claims. */
  async function orphanFixture(): Promise<{ box: Sandbox; docker: StubDocker; ctx: Context }> {
    const box = sandbox()
    const docker = stubDocker({ volumes: [{ name: 'old_pgdata', labels: labels('old', 'postgres'), size_bytes: 20971520 }] })
    const ctx = makeContext(box, docker)
    await project(ctx, 'alpha')
    return { box, docker, ctx }
  }

  test('removes an orphan after confirming, and reports what it reclaimed', async () => {
    const box = sandbox()
    const docker = stubDocker({ volumes: [{ name: 'old_pgdata', labels: labels('old', 'postgres'), size_bytes: 20971520 }] })
    const confirm = stubConfirm(true)
    const ctx = makeContext(box, docker, { confirm })
    await project(ctx, 'alpha')

    const output = await runVolumeRemove(ctx, { name: 'old_pgdata', force: false, json: false })
    assert.deepEqual(output, {
      volume: 'old_pgdata',
      removed: true,
      size_bytes: 20971520,
      size_human: '20 MB',
      last_project: 'old',
    })
    assert.ok(validate('volumes-rm', output).valid)
    assert.equal(confirm.questions.length, 1)
    assert.match(confirm.questions[0] ?? '', /destroyed/i)
    assert.deepEqual(docker.calls, [{ kind: 'removeVolume', name: 'old_pgdata' }])
  })

  test('declining removes nothing', async () => {
    const box = sandbox()
    const docker = stubDocker({ volumes: [{ name: 'old_pgdata', labels: labels('old', 'postgres'), size_bytes: 1 }] })
    const ctx = makeContext(box, docker, { confirm: stubConfirm(false) })
    await project(ctx, 'alpha')

    const output = await runVolumeRemove(ctx, { name: 'old_pgdata', force: false, json: false })
    assert.equal(output.removed, false)
    assert.deepEqual(docker.calls, [], 'a declined removal still removed the volume')
  })

  test('a volume a project still claims is VOLUME_IN_USE before Docker is asked', async () => {
    const box = sandbox()
    const docker = stubDocker({ volumes: [{ name: 'alpha_pgdata', labels: labels('alpha', 'postgres'), size_bytes: 1 }] })
    const ctx = makeContext(box, docker)
    await project(ctx, 'alpha', 'postgres')

    await assert.rejects(
      () => runVolumeRemove(ctx, { name: 'alpha_pgdata', force: true, json: true }),
      (error: unknown) =>
        error instanceof BardolierError && error.code === 'VOLUME_IN_USE' && error.details?.project === 'alpha',
    )
    assert.deepEqual(docker.calls, [])
  })

  test('a name Docker does not have is VOLUME_NOT_FOUND', async () => {
    const { ctx } = await orphanFixture()
    await assert.rejects(
      () => runVolumeRemove(ctx, { name: 'nope', force: true, json: true }),
      (error: unknown) => error instanceof BardolierError && error.code === 'VOLUME_NOT_FOUND',
    )
  })

  test('a container holding the volume wins over our scan', async () => {
    const box = sandbox()
    const docker = stubDocker({
      volumes: [{ name: 'old_pgdata', labels: labels('old', 'postgres'), size_bytes: 1 }],
      volumesInUse: ['old_pgdata'],
    })
    const ctx = makeContext(box, docker)
    await project(ctx, 'alpha')

    await assert.rejects(
      () => runVolumeRemove(ctx, { name: 'old_pgdata', force: true, json: true }),
      (error: unknown) => error instanceof BardolierError && error.code === 'VOLUME_IN_USE',
    )
  })

  test('under --json it refuses to guess at consent', async () => {
    const { ctx, docker } = await orphanFixture()
    await assert.rejects(
      () => runVolumeRemove(ctx, { name: 'old_pgdata', force: false, json: true }),
      (error: unknown) => error instanceof BardolierError && error.code === 'INVALID_ARGUMENT',
    )
    assert.deepEqual(docker.calls, [])
  })

  test('--force skips the prompt', async () => {
    const { ctx, docker } = await orphanFixture()
    const output = await runVolumeRemove(ctx, { name: 'old_pgdata', force: true, json: true })
    assert.equal(output.removed, true)
    assert.deepEqual(docker.calls, [{ kind: 'removeVolume', name: 'old_pgdata' }])
  })
})

// ── down-all (§6, Lifecycle / SSD) ────────────────────────────────────────────

describe('down-all (cli-spec.md §6)', () => {
  test('stops what is running and leaves what is not alone', async () => {
    const box = sandbox()
    const docker = stubDocker({ running: ['bardolier-alpha', 'bardolier-alpha-postgres'] })
    const ctx = makeContext(box, docker)
    await project(ctx, 'alpha', 'postgres')
    await project(ctx, 'beta')

    const output = await runDownAll(ctx)
    assert.deepEqual(output.stopped, ['alpha'])
    assert.deepEqual(output.projects, [
      { name: 'alpha', was_running: true },
      { name: 'beta', was_running: false },
    ])
    assert.ok(validate('down-all', output).valid)
    assert.deepEqual(
      docker.calls.filter((call) => call.kind === 'down').length,
      1,
      'a stopped project was torn down needlessly',
    )
  })

  test('never removes volumes — down-all keeps data like down does', async () => {
    const box = sandbox()
    const docker = stubDocker({
      running: ['bardolier-alpha', 'bardolier-alpha-postgres'],
      volumes: [{ name: 'alpha_pgdata', labels: labels('alpha', 'postgres'), size_bytes: 1 }],
    })
    const ctx = makeContext(box, docker)
    await project(ctx, 'alpha', 'postgres')

    await runDownAll(ctx)
    assert.deepEqual(docker.calls.filter((call) => call.kind === 'removeVolume'), [])
    assert.deepEqual(await docker.volumeNames(), ['alpha_pgdata'])
  })

  test('sweeps a bardolier container no manifest claims', async () => {
    const box = sandbox()
    const docker = stubDocker({ running: ['bardolier-ghost', 'unrelated-container'] })
    const ctx = makeContext(box, docker)
    await project(ctx, 'alpha')

    const output = await runDownAll(ctx)
    assert.deepEqual(output.stray_containers, ['bardolier-ghost'])
    assert.deepEqual(docker.calls, [{ kind: 'removeContainer', name: 'bardolier-ghost' }])
  })

  test('an unreachable daemon is a no-op success — nothing can be running', async () => {
    const box = sandbox()
    const ctx = makeContext(box, stubDocker({ available: true }))
    await project(ctx, 'alpha')

    const output = await runDownAll(makeContext(box, stubDocker({ available: false })))
    assert.equal(output.docker_available, false)
    assert.deepEqual(output.stopped, [])
    assert.deepEqual(output.projects, [{ name: 'alpha', was_running: false }])
  })
})

// ── eject (§6, Lifecycle / SSD) ───────────────────────────────────────────────

describe('eject (cli-spec.md §6)', () => {
  /** The mount point is whatever `containingVolume` derives from `box.root` on this machine (phase 17) — not a settable value. */
  function ejectContext(box: Sandbox, docker: StubDocker, device: StubDevice): Context {
    return makeContext(box, docker, { device })
  }

  test('stops everything, finds nothing holding it, and ejects', async () => {
    const box = sandbox()
    const docker = stubDocker({ running: ['bardolier-alpha'] })
    const device = stubDevice()
    const ctx = ejectContext(box, docker, device)
    await project(ctx, 'alpha')

    const output = await runEject(ctx)
    assert.deepEqual(output.stopped, ['alpha'])
    assert.equal(output.ejected, true)
    assert.deepEqual(output.holders, [])
    assert.deepEqual(device.ejected, [containingVolume(box.root)])
    assert.ok(validate('eject', output).valid)
  })

  test('a held volume is EJECT_BLOCKED with the holders named, and is not forced', async () => {
    const box = sandbox()
    const docker = stubDocker({ running: [] })
    const device = stubDevice([holder({ pid: 431, command: 'Xcode', paths: [`${box.root}/alpha`] })])
    const ctx = ejectContext(box, docker, device)
    await project(ctx, 'alpha')

    await assert.rejects(
      () => runEject(ctx),
      (error: unknown) => {
        assert.ok(error instanceof BardolierError)
        assert.equal(error.code, 'EJECT_BLOCKED')
        const holders = error.details?.holders as { command: string; pid: number }[]
        assert.deepEqual(holders.map((h) => h.command), ['Xcode'])
        assert.match(error.message, /Xcode \[pid 431\]/)
        assert.ok(validate('error', error.toPayload()).valid)
        return true
      },
    )
    assert.deepEqual(device.ejected, [], 'a blocked eject unmounted the disk anyway')
  })

  test('the same volume ejects once the holder quits', async () => {
    const box = sandbox()
    const device = stubDevice([holder({ command: 'zsh' })])
    const ctx = ejectContext(box, stubDocker({ running: [] }), device)
    await project(ctx, 'alpha')

    await assert.rejects(() => runEject(ctx), (error: unknown) => error instanceof BardolierError)
    device.setHolders([])
    const output = await runEject(ctx)
    assert.equal(output.ejected, true)
    assert.deepEqual(device.ejected, [containingVolume(box.root)])
  })

  test('containers come down BEFORE holders are checked — they are holders too', async () => {
    const box = sandbox()
    const docker = stubDocker({ running: ['bardolier-alpha'] })
    const order: string[] = []
    const device: StubDevice = {
      ejected: [],
      setHolders() {},
      setRuntimeHolders() {},
      setRemovable() {},
      releaseRuntimeAfter() {},
      runtimeProbes: () => 0,
      async removable() {
        return true
      },
      async holders() {
        order.push('holders')
        return []
      },
      async runtimeHolders() {
        return []
      },
      async eject() {
        order.push('eject')
      },
    }
    const recording = {
      ...docker,
      async composeDown(target: Parameters<StubDocker['composeDown']>[0]) {
        order.push('down')
        await docker.composeDown(target)
      },
    }
    const ctx = makeContext(box, recording, { device })
    await project(ctx, 'alpha')

    await runEject(ctx)
    assert.deepEqual(order, ['down', 'holders', 'eject'])
  })

  test('an absent root is SSD_NOT_MOUNTED and stops nothing', async () => {
    const box = sandbox()
    const docker = stubDocker({ running: ['bardolier-alpha'] })
    const device = stubDevice()
    const ctx = makeContext(box, docker, { device, env: { BARDOLIER_ROOT: `${box.root}-gone` } })

    await assert.rejects(
      () => runEject(ctx),
      (error: unknown) => error instanceof BardolierError && error.code === 'SSD_NOT_MOUNTED',
    )
    assert.deepEqual(docker.calls, [])
    assert.deepEqual(device.ejected, [])
  })
})

// ── the host probes (§6) ──────────────────────────────────────────────────────

describe('the lsof/diskutil seam', () => {
  const LSOF = ['p431', 'cXcode', 'Lmark', 'fcwd', 'n/Volumes/ssd/claude-projects/alpha', 'p9', 'czsh', 'Lmark', 'n/Volumes/ssd'].join(
    '\n',
  )

  test('parses lsof machine output into holders', () => {
    const holders = parseLsof(LSOF, '/Volumes/ssd')
    assert.deepEqual(holders, [
      { pid: 9, command: 'zsh', user: 'mark', paths: ['/Volumes/ssd'] },
      { pid: 431, command: 'Xcode', user: 'mark', paths: ['/Volumes/ssd/claude-projects/alpha'] },
    ])
  })

  test('ignores what a process holds elsewhere', () => {
    const holders = parseLsof(['p1', 'claunchd', 'Lroot', 'n/dev/null'].join('\n'), '/Volumes/ssd')
    assert.deepEqual(holders[0]?.paths, [])
  })

  test('no match is no holders, not a failure', async () => {
    const device = createSsdDevice(async () => ({ code: 1, stdout: '', stderr: '' }))
    assert.deepEqual(await device.holders('/Volumes/ssd'), [])
  })

  test('a broken lsof refuses rather than reporting "nothing holds it"', async () => {
    const device = createSsdDevice(async () => ({ code: 127, stdout: '', stderr: 'lsof: command not found' }))
    await assert.rejects(
      () => device.holders('/Volumes/ssd'),
      (error: unknown) => error instanceof BardolierError && error.code === 'EJECT_BLOCKED',
    )
  })

  test('our own process is not a holder; the shell that launched it is', async () => {
    const device = createSsdDevice(async () => ({ code: 0, stdout: LSOF, stderr: '' }), 431)
    const holders = await device.holders('/Volumes/ssd')
    assert.deepEqual(holders.map((h) => h.pid), [9])
  })

  test('a diskutil refusal is EJECT_BLOCKED, never retried with force', async () => {
    const calls: string[][] = []
    const device = createSsdDevice(async (command, args) => {
      calls.push([command, ...args])
      return { code: 1, stdout: '', stderr: 'Unmount failed: dissenter' }
    })
    await assert.rejects(
      () => device.eject('/Volumes/ssd'),
      (error: unknown) => error instanceof BardolierError && error.code === 'EJECT_BLOCKED',
    )
    assert.deepEqual(calls, [['diskutil', 'eject', '/Volumes/ssd']])
  })
})

// ── the whole loop ────────────────────────────────────────────────────────────

describe('new → up → shell → down → remove → reclaim → delete → eject', () => {
  test('one story, end to end', async () => {
    const box = sandbox()
    const docker = stubDocker({
      startsAs: ['bardolier-alpha', 'bardolier-alpha-postgres'],
      volumes: [{ name: 'alpha_pgdata', labels: labels('alpha', 'postgres'), size_bytes: 20971520 }],
    })
    const device = stubDevice()
    const ctx = makeContext(box, docker, { device, confirm: stubConfirm(true) })

    await project(ctx, 'alpha', 'postgres')
    const up = await runUp(ctx, { name: 'alpha', noShell: false })
    assert.equal(up.state, 'running')

    const shell = await runShell(ctx, 'alpha')
    assert.deepEqual(shell.exec, ['docker', 'exec', '-it', 'bardolier-alpha', 'bash'])

    const status = await collectStatus(ctx, 'alpha')
    assert.equal(status.projects[0]?.services[0]?.host_port, up.services[0]?.host_port)
    assert.deepEqual(status.orphaned_volumes, [], 'an attached volume is not an orphan while the project is up')

    await runDownAll(ctx)
    await runServiceRemove(ctx, { project: 'alpha', service: 'postgres' })

    const orphaned = await collectOrphanedVolumes(ctx)
    assert.deepEqual(orphaned.orphaned.map((v) => v.name), ['alpha_pgdata'])
    assert.equal(orphaned.total_human, '20 MB')

    const reclaimed = await runVolumeRemove(ctx, { name: 'alpha_pgdata', force: true, json: true })
    assert.equal(reclaimed.removed, true)
    assert.deepEqual((await collectOrphanedVolumes(ctx)).orphaned, [])

    await runDelete(ctx, { name: 'alpha', force: true, keepData: false, purge: false, json: true })
    assert.equal(box.exists('alpha'), false)

    device.setHolders([holder({ command: 'zsh' })])
    await assert.rejects(
      () => runEject(ctx),
      (error: unknown) => error instanceof BardolierError && error.code === 'EJECT_BLOCKED',
    )
    device.setHolders([])
    assert.equal((await runEject(ctx)).ejected, true)
    assert.deepEqual(device.ejected, [containingVolume(box.root)])
  })
})

describe('holders the user cannot act on', () => {
  const DOCKER_LSOF = ['p23619', 'ccom.apple.Virtualization.Virtua', 'Lmark', 'n/Volumes/ssd/claude-projects/alpha'].join('\n')

  test("the container runtime's own descriptors do not block an eject", async () => {
    // Docker Desktop holds a descriptor on every bind-mounted path for as long
    // as the share exists — including after down-all. Reporting it would make
    // "quit Docker" the answer to every eject.
    const device = createSsdDevice(async () => ({ code: 0, stdout: DOCKER_LSOF, stderr: '' }))
    assert.deepEqual(await device.holders('/Volumes/ssd'), [])
    assert.equal(isRuntimeHolder('com.docker.backend'), true)
    assert.equal(isRuntimeHolder('Xcode'), false)
  })

  test('but a real user process alongside it still does', async () => {
    const stdout = `${DOCKER_LSOF}\np431\ncXcode\nLmark\nn/Volumes/ssd/claude-projects/alpha`
    const device = createSsdDevice(async () => ({ code: 0, stdout, stderr: '' }))
    assert.deepEqual((await device.holders('/Volumes/ssd')).map((h) => h.command), ['Xcode'])
  })

  // Spotlight is the one that made "Close all & eject" impossible rather than
  // merely inconvenient: `mds_stores` maps the volume's index for as long as it
  // is mounted, so counting it is a refusal with no end state.
  const SPOTLIGHT_LSOF = [
    'p343',
    'cmds',
    'Lroot',
    'n/Volumes/ssd',
    'p556',
    'cmds_stores',
    'Lroot',
    'n/Volumes/ssd/.Spotlight-V100/Store-V2/67C1D8EB/store.db',
    'p654',
    'ccom.apple.quicklook.ThumbnailsAgent',
    'Lmark',
    'n/Volumes/ssd/claude-projects/alpha/project.yml',
  ].join('\n')

  test('Spotlight and the preview agents never block an eject', async () => {
    const device = createSsdDevice(async () => ({ code: 0, stdout: SPOTLIGHT_LSOF, stderr: '' }))
    assert.deepEqual(await device.holders('/Volumes/ssd'), [])
    assert.equal(isSystemHolder('mds_stores'), true)
    assert.equal(isSystemHolder('mdworker_shared'), true)
    assert.equal(isSystemHolder('com.apple.quicklook.ThumbnailsAgent'), true)
    assert.equal(isSystemHolder('Xcode'), false)
    // An editor indexing a repo on the SSD is a real holder with a real fix.
    assert.equal(isSystemHolder('plugin_host-3.8'), false)
  })

  test('a user process is still named when the system agents are there too', async () => {
    const stdout = `${SPOTLIGHT_LSOF}\np51310\ncplugin_host-3.8\nLmark\nn/Volumes/ssd/analysta/.git/objects/10/5c57`
    const device = createSsdDevice(async () => ({ code: 0, stdout, stderr: '' }))
    assert.deepEqual((await device.holders('/Volumes/ssd')).map((h) => h.command), ['plugin_host-3.8'])
  })
})

describe('a refusal always names something (§6)', () => {
  test("diskutil's dissenter becomes a holder, in every shape it prints it", () => {
    assert.deepEqual(
      parseDissenter('Volume ssd on disk5s1 failed to eject\nDissenter PID = 51310 (plugin_host-3.8), Status = 0x0000c010'),
      [{ pid: 51310, command: 'plugin_host-3.8', user: null, paths: [] }],
    )
    assert.deepEqual(
      parseDissenter('Unmount failed for /Volumes/ssd: dissented by PID 556 (mds_stores)').map((h) => h.command),
      ['mds_stores'],
    )
  })

  test('a refusal that names no PID invents no holder', () => {
    assert.deepEqual(parseDissenter('Unmount of disk5s1 failed: at least one volume could not be unmounted'), [])
  })

  test('the blocked eject carries the dissenter lsof could not see', async () => {
    // holders() runs unprivileged, so a root dissenter is named HERE or nowhere.
    const device = createSsdDevice(async () => ({
      code: 1,
      stdout: '',
      stderr: 'Volume ssd on disk5s1 failed to eject\nDissenter PID = 556 (mds_stores), Status = 0x0000c010',
    }))
    await assert.rejects(
      () => device.eject('/Volumes/ssd'),
      (error: unknown) => {
        assert.ok(error instanceof BardolierError)
        assert.equal(error.code, 'EJECT_BLOCKED')
        const holders = error.details?.holders as { pid: number; command: string }[]
        assert.deepEqual(holders.map((h) => h.pid), [556])
        // A system agent gets the advice that fits it — there is nothing to quit.
        assert.match(error.message, /try again in a moment/)
        return true
      },
    )
  })

  test('an app that can be quit is told to quit', async () => {
    const device = createSsdDevice(async () => ({
      code: 1,
      stdout: 'Dissenter PID = 431 (Xcode), Status = 0x0000c010',
      stderr: '',
    }))
    await assert.rejects(
      () => device.eject('/Volumes/ssd'),
      (error: unknown) => error instanceof BardolierError && /Xcode \[pid 431\] — close it and try again/.test(error.message),
    )
  })
})
