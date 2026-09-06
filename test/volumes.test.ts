/**
 * Orphan derivation and reclaiming — directories and named volumes both.
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { BardolierError } from '../cli/src/errors.ts'
import { validate } from '../cli/src/schema.ts'
import { formatBytes, scanVolumes } from '../cli/src/volumes.ts'
import { serviceDataDir, dataDir } from '../cli/src/layout.ts'
import { parseDockerSize } from '../cli/src/docker.ts'
import { runNew } from '../cli/src/commands/new.ts'
import { runServiceRemove } from '../cli/src/commands/service.ts'
import { runDelete } from '../cli/src/commands/delete.ts'
import { collectStatus } from '../cli/src/commands/status.ts'
import { collectOrphanedVolumes, runVolumeRemove } from '../cli/src/commands/volumes.ts'
import type { Context } from '../cli/src/context.ts'
import {
  catalogue,
  labels,
  makeContext,
  manifest,
  project,
  type Sandbox,
  sandboxes,
  seedServiceData,
  stubConfirm,
  stubDocker,
  type StubDocker,
} from './helpers.ts'

const sandbox = sandboxes()

// ── orphan derivation (§6, Volumes / disk; §7) ────────────────────────────────
describe('orphaned volumes (cli-spec.md §6, §7)', () => {
  test('a data directory a project still attaches is not an orphan', async () => {
    const box = sandbox()
    const ctx = makeContext(box, stubDocker())
    await project(ctx, 'alpha', { services: 'postgres' })
    seedServiceData(box, 'alpha', 'postgres')

    const output = await collectOrphanedVolumes(ctx)
    assert.deepEqual(output.orphaned, [])
    assert.equal(output.total_bytes, 0)
  })

  test('detaching the service makes its data directory an orphan, attributed and sized', async () => {
    const box = sandbox()
    const ctx = makeContext(box, stubDocker())
    await project(ctx, 'alpha', { services: 'postgres' })
    const dir = seedServiceData(box, 'alpha', 'postgres', 1024)

    await runServiceRemove(ctx, { project: 'alpha', service: 'postgres' })

    const output = await collectOrphanedVolumes(ctx)
    assert.deepEqual(output.orphaned, [
      {
        name: 'alpha/postgres',
        kind: 'directory',
        path: dir,
        size_bytes: 1024,
        size_human: '1 KB',
        last_project: 'alpha',
      },
    ])
    assert.equal(output.total_human, '1 KB')
    assert.ok(validate('volumes-orphaned', output).valid)
  })

  test('the Spotlight marker data/ is created with is never offered for reclaiming', async () => {
    const box = sandbox()
    const ctx = makeContext(box, stubDocker())
    await project(ctx, 'alpha')
    assert.ok(existsSync(join(box.path('alpha'), 'data', '.metadata_never_index')))

    assert.deepEqual((await collectOrphanedVolumes(ctx)).orphaned, [])
  })

  test('deleting the project takes its data with it — there is no orphan left', async () => {
    const box = sandbox()
    const ctx = makeContext(box, stubDocker())
    await project(ctx, 'alpha', { services: 'postgres' })
    seedServiceData(box, 'alpha', 'postgres')

    const deleted = await runDelete(ctx, { name: 'alpha', force: true, purge: true, json: true })
    assert.deepEqual(deleted.kept_volumes, [])

    assert.deepEqual((await collectOrphanedVolumes(ctx)).orphaned, [])
  })

  test('a named volume left by an older layout is ours, and nothing claims it', async () => {
    // Nothing creates these any more (phase 19), but a machine that ran the
    // old layout still has them — and hiding gigabytes from the one command
    // that accounts for disk would be the wrong kind of quiet.
    const box = sandbox()
    const docker = stubDocker({ volumes: [{ name: 'old_pgdata', labels: labels('old', 'postgres'), size_bytes: 20971520 }] })
    const ctx = makeContext(box, docker)
    await project(ctx, 'alpha', { services: 'postgres' })

    const output = await collectOrphanedVolumes(ctx)
    assert.deepEqual(output.orphaned, [
      { name: 'old_pgdata', kind: 'volume', path: null, size_bytes: 20971520, size_human: '20 MB', last_project: 'old' },
    ])
  })

  test('a volume that is not ours is never listed, labelled or not', async () => {
    const box = sandbox()
    const docker = stubDocker({ volumes: ['someone-elses-data', { name: 'ci_cache', labels: { 'other.tool': 'yes' } }] })
    const ctx = makeContext(box, docker)
    await project(ctx, 'alpha')

    assert.deepEqual((await collectOrphanedVolumes(ctx)).orphaned, [])
  })

  test('an attachment the catalogue no longer defines still protects its data', async () => {
    // The claim comes from the MANIFEST, not the catalogue: a key the catalogue
    // has forgotten is still attached, and listing its directory would offer
    // live data for deletion.
    const box = sandbox()
    const ctx = makeContext(box, stubDocker())
    await project(ctx, 'alpha')
    box.writeProject('alpha', {
      name: 'alpha',
      archetype: 'web',
      base_image: 'bardolier-web',
      services: { kafka: { host_port: 9092 } },
      created: '2026-08-19T10:00:00.000Z',
    })
    seedServiceData(box, 'alpha', 'kafka')

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
    const docker = stubDocker({ volumes: [] })
    const counting = { ...docker, volumeSizes: async () => (measured++, docker.volumeSizes()) }
    const ctx = makeContext(box, counting)
    await project(ctx, 'alpha', { services: 'postgres' })

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
      kind: 'volume',
      path: null,
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

  test('a data directory a project still attaches is VOLUME_IN_USE before Docker is asked', async () => {
    const box = sandbox()
    const docker = stubDocker()
    const ctx = makeContext(box, docker)
    await project(ctx, 'alpha', { services: 'postgres' })
    seedServiceData(box, 'alpha', 'postgres')

    await assert.rejects(
      () => runVolumeRemove(ctx, { name: 'alpha/postgres', force: true, json: true }),
      (error: unknown) =>
        error instanceof BardolierError && error.code === 'VOLUME_IN_USE' && error.details?.project === 'alpha',
    )
    assert.deepEqual(docker.calls, [])
    assert.ok(existsSync(serviceDataDir(box.path('alpha'), 'postgres')))
  })

  test('a detached data directory is removed by name or by path', async () => {
    const box = sandbox()
    const ctx = makeContext(box, stubDocker(), { confirm: stubConfirm(true) })
    await project(ctx, 'alpha', { services: 'postgres' })
    const dir = seedServiceData(box, 'alpha', 'postgres')
    await runServiceRemove(ctx, { project: 'alpha', service: 'postgres' })

    const output = await runVolumeRemove(ctx, { name: dir, force: true, json: true })
    assert.equal(output.removed, true)
    assert.equal(output.kind, 'directory')
    assert.equal(output.volume, 'alpha/postgres')
    assert.ok(validate('volumes-rm', output).valid)
    assert.equal(existsSync(dir), false, 'the directory must be gone')
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

// ── orphaned data directories (§6, §7) ───────────────────────────────────────
describe('a detached service’s data directory', () => {
  async function detached(box: Sandbox) {
    const ctx = makeContext(box, stubDocker())
    await runNew(ctx, { name: 'alpha', archetype: 'web', services: 'postgres' })
    writeFileSync(join(serviceDataDir(box.path('alpha'), 'postgres'), 'PG_VERSION'), '17\n')
    await runServiceRemove(ctx, { project: 'alpha', service: 'postgres' })
    return ctx
  }

  test('is kept, and reported as a directory orphan with its path and size', async () => {
    const box = sandbox()
    const ctx = await detached(box)

    const output = await collectOrphanedVolumes(ctx)
    assert.deepEqual(output.orphaned, [
      {
        name: 'alpha/postgres',
        kind: 'directory',
        path: serviceDataDir(box.path('alpha'), 'postgres'),
        size_bytes: 3,
        size_human: '3 B',
        last_project: 'alpha',
      },
    ])
    assert.ok(validate('volumes-orphaned', output).valid)
  })

  test('needs only its own root — another root being unreadable is not its business', async () => {
    // The claim is `ls data/` against the manifest beside it. No labels, no
    // Docker, no second root consulted: the directory's own project answers.
    const box = sandbox()
    const ctx = await detached(box)
    const scan = await collectOrphanedVolumes(ctx)
    assert.equal(scan.orphaned[0]?.last_project, 'alpha')
  })

  test('`volumes rm` takes it, by name or by path', async () => {
    const box = sandbox()
    const ctx = await detached(box)
    const path = serviceDataDir(box.path('alpha'), 'postgres')

    const removed = await runVolumeRemove(ctx, { name: path, force: true, json: true })
    assert.equal(removed.removed, true)
    assert.equal(removed.kind, 'directory')
    assert.equal(existsSync(path), false)
  })

  test('a loose file under data/ is not a service, and neither is the marker', async () => {
    const box = sandbox()
    const ctx = makeContext(box, stubDocker())
    await runNew(ctx, { name: 'alpha', archetype: 'web', services: undefined })
    writeFileSync(join(dataDir(box.path('alpha')), 'notes.txt'), 'scratch\n')

    assert.deepEqual((await collectOrphanedVolumes(ctx)).orphaned, [])
  })
})
