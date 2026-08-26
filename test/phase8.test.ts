/**
 * Phase 8 — the mobile base images and the boundary they encode. Building them
 * for real takes a daemon, a network and gigabytes (phase8-done-check.sh); what
 * a fast test owns is everything the built image is judged against:
 *   - THE MAP IS COMPLETE: every §4.3 archetype resolves to a Dockerfile that
 *     exists, so `unavailable` means "not built yet", never "never will be".
 *   - THE BUILD-ARG CONTRACT: each Dockerfile takes HOST_UID/HOST_GID and drops
 *     to that user at /work — the whole reason `cproj build` exists. Skipping it
 *     hands the Mac root-owned files, and only a real build would notice.
 *   - THE PIN AGREES WITH ITSELF: `claude-and` is x86_64-only because aapt2 is,
 *     and `build` and the generated compose file must both say so. One
 *     constant, two readers.
 *   - THE BOUNDARY IS IN THE IMAGE: no `xcodebuild` in the ios base, no `adb`
 *     in the android one — a rule the container cannot disobey. Asserted here
 *     against the seeded CLAUDE.md (§10) that states it.
 */

import { test, describe, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { validate } from '../cli/src/schema.ts'
import { IMAGE_CACHE, IMAGE_PLATFORM, baseImages } from '../cli/src/images.ts'
import { renderCompose } from '../cli/src/compose.ts'
import { runBuild } from '../cli/src/commands/build.ts'
import { runNew } from '../cli/src/commands/new.ts'
import { runUp } from '../cli/src/commands/up.ts'
import { runDelete } from '../cli/src/commands/delete.ts'
import { runVolumeRemove } from '../cli/src/commands/volumes.ts'
import { scanVolumes } from '../cli/src/volumes.ts'
import { CprojError } from '../cli/src/errors.ts'
import { ARCHETYPES, ARCHETYPE_BASE_IMAGE, BASE_IMAGES } from '../cli/src/model/archetype.ts'
import { seededFiles } from '../cli/src/scaffold.ts'
import type { ServiceCatalogue } from '../cli/src/model/catalogue.ts'
import { makeContext, makeSandbox, manifest, stubDocker, type Sandbox } from './helpers.ts'

const sandboxes: Sandbox[] = []
function sandbox(): Sandbox {
  const created = makeSandbox()
  sandboxes.push(created)
  return created
}
afterEach(() => {
  while (sandboxes.length > 0) sandboxes.pop()?.cleanup()
})

/** The bundled catalogue, which is what a real run resolves to (§4.1). */
function catalogue(): ServiceCatalogue {
  return makeContext(sandbox()).catalogue().catalogue
}

/** The Dockerfile text of a base image, read the way `docker build` would. */
function dockerfile(image: string): string {
  const definition = baseImages().find((candidate) => candidate.image === image)
  assert.ok(definition?.dockerfile, `${image} has no Dockerfile`)
  return readFileSync(definition.dockerfile, 'utf8')
}

// ── The §4.3 map, completed ───────────────────────────────────────────────────

describe('every archetype now has a base image (cli-spec.md §4.3)', () => {
  test('each declared image is written, and each archetype resolves to one', () => {
    for (const definition of baseImages()) {
      assert.ok(definition.dockerfile, `${definition.image} is declared in §4.3 but has no Dockerfile`)
    }
    for (const archetype of ARCHETYPES) {
      const image = ARCHETYPE_BASE_IMAGE[archetype]
      assert.ok(BASE_IMAGES.includes(image), `${archetype} maps to an image that does not exist`)
    }
    // ios and android are the two the map has been waiting on.
    assert.equal(ARCHETYPE_BASE_IMAGE.ios, 'claude-ios')
    assert.equal(ARCHETYPE_BASE_IMAGE.android, 'claude-and')
  })

  test('`build` with no argument reports nothing unavailable', async () => {
    const box = sandbox()
    const docker = stubDocker()
    const result = await runBuild(makeContext(box, docker), undefined)

    assert.ok(validate('build', result).valid, 'build output must match build.schema.json')
    assert.deepEqual(
      result.images.map((image) => [image.image, image.status]),
      [
        ['claude-web', 'built'],
        ['claude-ios', 'built'],
        ['claude-and', 'built'],
      ],
    )
    // Every build carries the host identity — the point of the command.
    for (const call of docker.calls) {
      assert.ok(call.kind === 'build')
      assert.deepEqual(call.request.args, { HOST_UID: '501', HOST_GID: '20' })
    }
  })

  test('`build --archetype ios` and `--archetype android` reach their own Dockerfiles', async () => {
    for (const [archetype, image] of [
      ['ios', 'claude-ios'],
      ['android', 'claude-and'],
    ] as const) {
      const box = sandbox()
      const docker = stubDocker()
      const result = await runBuild(makeContext(box, docker), archetype)
      assert.deepEqual(result.images.map((entry) => entry.image), [image])

      const call = docker.calls[0]
      assert.ok(call?.kind === 'build')
      assert.equal(call.request.tag, image)
      assert.ok(call.request.dockerfile.endsWith(join(image, 'Dockerfile')))
    }
  })
})

// ── The build-arg contract every base image keeps ─────────────────────────────

describe('the base images keep the ownership contract (HOST_UID/HOST_GID)', () => {
  for (const image of BASE_IMAGES) {
    test(`${image} takes the host identity and works at /work as that user`, () => {
      const text = dockerfile(image)
      // These four are what `cproj build` and `compose.ts` assume between them.
      assert.match(text, /ARG HOST_UID/, 'no HOST_UID build arg: files would come back root-owned')
      assert.match(text, /ARG HOST_GID/)
      assert.match(text, /USER \$\{HOST_UID\}:\$\{HOST_GID\}/, 'the image still runs as root')
      assert.match(text, /WORKDIR \/work/, 'the bind mount lands at /work (compose.ts WORKDIR)')
      // `-o` is what lets the container reuse macOS's uid 501 / gid 20 even
      // when the distro already owns them.
      assert.match(text, /groupadd -o/)
      assert.match(text, /useradd -o/)
    })
  }
})

// ── The one architecture pin, read by two writers ─────────────────────────────

describe('claude-and is pinned to linux/amd64, consistently (images.ts)', () => {
  test('only the android base is pinned, and it is pinned to x86_64', () => {
    assert.deepEqual(IMAGE_PLATFORM, { 'claude-and': 'linux/amd64' })
    const byImage = Object.fromEntries(baseImages().map((d) => [d.image, d.platform]))
    assert.deepEqual(byImage, {
      'claude-web': null,
      'claude-ios': null,
      'claude-and': 'linux/amd64',
    })
  })

  test('`build` passes --platform for it, and for nothing else', async () => {
    const box = sandbox()
    const docker = stubDocker()
    const result = await runBuild(makeContext(box, docker), undefined)

    const platforms = docker.calls.map((call) => (call.kind === 'build' ? call.request.platform ?? null : null))
    assert.deepEqual(platforms, [null, null, 'linux/amd64'])

    // And it says so in the output, only where it is true.
    const reported = Object.fromEntries(result.images.map((image) => [image.image, image.platform ?? null]))
    assert.deepEqual(reported, {
      'claude-web': null,
      'claude-ios': null,
      'claude-and': 'linux/amd64',
    })
  })

  test('the generated compose file starts the dev container on the same platform', () => {
    const services = catalogue()
    const android = renderCompose({ manifest: manifest('droid', { archetype: 'android', base_image: 'claude-and' }), catalogue: services })
    assert.match(android, /platform: linux\/amd64/)

    // …and adds nothing for an unpinned image, so no existing project's
    // generated file gains a diff (§9 determinism).
    const web = renderCompose({ manifest: manifest('site'), catalogue: services })
    assert.ok(!web.includes('platform:'), 'an unpinned base image must not emit a platform key')

    // Same manifest, same bytes — the pin is not a new source of drift.
    assert.equal(android, renderCompose({ manifest: manifest('droid', { archetype: 'android', base_image: 'claude-and' }), catalogue: services }))
  })

  test('`new android` writes a compose file the daemon can actually start', async () => {
    const box = sandbox()
    await runNew(makeContext(box), { name: 'droid', archetype: 'android', services: undefined })
    const compose = readFileSync(join(box.root, 'droid', 'docker-compose.yml'), 'utf8')
    assert.match(compose, /image: claude-and:latest/)
    assert.match(compose, /platform: linux\/amd64/)
  })
})

// ── The boundary, as a fact about the image ───────────────────────────────────

describe('the mobile images encode the host/container boundary (CLAUDE.md)', () => {
  test('claude-ios carries the Swift toolchain and swiftlint, and no host-only build', () => {
    const text = dockerfile('claude-ios')
    assert.match(text, /^FROM swift:/m, 'the ios base must be the open-source Swift toolchain')
    assert.match(text, /swiftlint/, 'swiftlint is half of what the ios archetype can do in here (§4.3)')
    // Nothing in here may look like a way to build the app: those steps are the
    // human's, on the Mac.
    assert.ok(!/^\s*RUN[^\n]*xcodebuild/m.test(text), 'the ios base must not invoke xcodebuild')
    assert.ok(!/simulator|xcrun simctl/i.test(text.replace(/^#.*$/gm, '')), 'no simulator belongs in a Linux image')
  })

  test('claude-and carries the SDK and Gradle, and no adb', () => {
    const text = dockerfile('claude-and')
    assert.match(text, /^FROM eclipse-temurin:/m, 'the android base needs a JDK')
    assert.match(text, /sdkmanager/, 'the Android SDK is installed with sdkmanager')
    assert.match(text, /gradle-\$\{GRADLE_VERSION\}/, 'a Gradle on PATH for projects without a wrapper')
    assert.match(text, /ANDROID_HOME=/)
    // platform-tools exists to talk to a device or emulator; both are host-side,
    // so leaving it out makes the boundary a property of the image.
    const instructions = text.replace(/^#.*$/gm, '')
    assert.ok(!/platform-tools/.test(instructions), 'platform-tools (adb) must not be installed')
    assert.ok(!/emulator/.test(instructions), 'the emulator is host-side')
  })

  test('every base image pins its toolchain version, so the same file builds the same image', () => {
    // A floating `latest` would make two builds of one Dockerfile differ —
    // the same determinism rule the compose file is held to (§9).
    assert.match(dockerfile('claude-web'), /ARG NODE_VERSION=\d/)
    assert.match(dockerfile('claude-ios'), /ARG SWIFT_VERSION=\d/)
    assert.match(dockerfile('claude-ios'), /ARG SWIFTLINT_VERSION=\d/)
    const android = dockerfile('claude-and')
    for (const arg of ['JAVA_VERSION', 'ANDROID_CMDLINE_TOOLS', 'ANDROID_PLATFORM', 'ANDROID_BUILD_TOOLS', 'GRADLE_VERSION']) {
      assert.match(android, new RegExp(`ARG ${arg}=`), `${arg} is not pinned`)
    }
  })

  test('the seeded CLAUDE.md steers the agent the same way the image does (§10)', () => {
    const ios = seededFiles('myapp', 'ios').find((file) => file.name === 'CLAUDE.md')?.contents ?? ''
    assert.match(ios, /xcodebuild/, 'the ios note must name the command it is forbidding')
    assert.match(ios, /swiftlint/, 'and what the container CAN do instead')
    assert.match(ios, /logic tests/)

    const android = seededFiles('myapp', 'android').find((file) => file.name === 'CLAUDE.md')?.contents ?? ''
    assert.match(android, /Gradle builds and unit tests \*\*run in this container\*\*/)
    assert.match(android, /adb/, 'the android note must name adb, which the image does not carry')
  })
})

// ── The Gradle cache: shared, and on the internal disk ────────────────────────

describe('the android toolchain cache is shared, not per project (images.ts)', () => {
  const CACHE = 'cproj-gradle-cache'
  const MOUNT = '/cache/gradle'

  /** A manifest for an android project, which is the only kind with a cache. */
  function droid(name = 'droid') {
    return manifest(name, { archetype: 'android', base_image: 'claude-and' })
  }

  test('one image declares a cache, and its Dockerfile puts Gradle in it', () => {
    assert.deepEqual(IMAGE_CACHE, { 'claude-and': { volume: CACHE, mount: MOUNT } })
    const byImage = Object.fromEntries(baseImages().map((d) => [d.image, d.cache?.volume ?? null]))
    assert.deepEqual(byImage, { 'claude-web': null, 'claude-ios': null, 'claude-and': CACHE })

    // The coupling that a wrong answer makes silent: Gradle writing somewhere
    // the volume is not mounted still WORKS — it just re-downloads every run,
    // into a container layer, which is the thing this exists to stop.
    const text = dockerfile('claude-and')
    assert.match(text, new RegExp(`ENV GRADLE_USER_HOME=${MOUNT}\\b`))
    assert.ok(!/GRADLE_USER_HOME=\/work/.test(text), 'a per-project cache would sit on the SSD')
    // Docker seeds a new named volume from the image's directory, ownership and
    // all, and there is no sudo in there to fix a root-owned mount afterwards.
    assert.match(text, new RegExp(`mkdir -p[^\\n]*${MOUNT}`))
    assert.match(text, /chown -R "\$\{HOST_UID\}:\$\{HOST_GID\}"[^\n]*\/cache/)
  })

  test('the compose file mounts it, and lets Compose neither create nor claim it', () => {
    const services = catalogue()
    const android = renderCompose({ manifest: droid(), catalogue: services })
    assert.match(android, new RegExp(`- ${CACHE}:${MOUNT}`))
    // `external: true` is the whole trick: a Compose-created volume carries the
    // FIRST project's compose labels, and every other android project then
    // warns about it on every `up`.
    assert.match(android, new RegExp(`${CACHE}:\\n\\s+name: ${CACHE}\\n\\s+external: true`))
    assert.ok(!android.includes('cproj.project: droid\n    cproj.service'), 'the cache is no project’s volume')

    // Nothing changes for an image without a cache — no mount, no volumes key.
    const web = renderCompose({ manifest: manifest('site'), catalogue: services })
    assert.ok(!web.includes(CACHE), 'an image with no cache must not gain one')
    // It DOES declare its own home volume — every project has one — but nothing
    // shared: the cache is the android image's, and a web project never sees it.
    assert.match(web, /\nvolumes:\n/)
    assert.ok(!web.includes('external: true'), 'a web project shares no volume with anyone')

    // Same manifest, same bytes (§9).
    assert.equal(android, renderCompose({ manifest: droid(), catalogue: services }))
  })

  test('`up` creates the volume before Compose asks for it, and only for that image', async () => {
    const box = sandbox()
    const docker = stubDocker({ startsAs: ['cproj-droid'] })
    const ctx = makeContext(box, docker)
    await runNew(ctx, { name: 'droid', archetype: 'android', services: undefined })
    await runUp(ctx, { name: 'droid', noShell: true })

    const kinds = docker.calls.map((call) => call.kind)
    assert.deepEqual(kinds, ['ensureVolume', 'up'], 'an external volume must exist before `compose up` runs')
    const created = docker.calls.find((call) => call.kind === 'ensureVolume')
    assert.equal(created?.kind === 'ensureVolume' ? created.name : null, CACHE)
    // Labelled as the cache, and NOT as any project's: that label is what makes
    // the orphan scan treat it as shared rather than as `droid`'s to reclaim.
    assert.deepEqual(created?.kind === 'ensureVolume' ? created.labels : null, { 'cproj.role': 'cache' })

    const web = stubDocker({ startsAs: ['cproj-site'] })
    const webCtx = makeContext(sandbox(), web)
    await runNew(webCtx, { name: 'site', archetype: 'web', services: undefined })
    await runUp(webCtx, { name: 'site', noShell: true })
    assert.deepEqual(web.calls.map((call) => call.kind), ['up'], 'a web project needs no cache volume')
  })

  test('it is claimed while any android project exists, and reclaimable once none does', async () => {
    const box = sandbox()
    const docker = stubDocker({ volumes: [{ name: CACHE, labels: { 'cproj.role': 'cache' }, size_bytes: 20971520 }] })
    const ctx = makeContext(box, docker)
    await runNew(ctx, { name: 'droid', archetype: 'android', services: undefined })
    await runNew(ctx, { name: 'site', archetype: 'web', services: undefined })

    const held = await scanVolumes(ctx)
    assert.deepEqual(held.orphans, [], 'a cache a project still builds with is not disk to reclaim')
    assert.equal(held.claimedBy.get(CACHE), 'droid')

    // The last android project goes, and with it the only reason to keep it.
    await runDelete(ctx, { name: 'droid', force: true, keepData: true, purge: false, json: true })
    const freed = await scanVolumes(ctx)
    assert.deepEqual(freed.orphans.map((orphan) => orphan.name), [CACHE])
    // No project made it, so none is named as its last — the schema allows that
    // and inventing one would be a lie about where the data came from.
    assert.equal(freed.orphans[0]?.last_project, null)
    assert.equal(freed.orphans[0]?.size_human, '20 MB')
  })

  test('`volumes rm` refuses it with the reason that fits a shared volume', async () => {
    const box = sandbox()
    const docker = stubDocker({ volumes: [{ name: CACHE, labels: { 'cproj.role': 'cache' }, size_bytes: 1024 }] })
    const ctx = makeContext(box, docker)
    await runNew(ctx, { name: 'droid', archetype: 'android', services: undefined })

    // Refused before Docker is asked, and with an instruction that fits: there
    // is no service to detach from a volume no service owns.
    await assert.rejects(
      () => runVolumeRemove(ctx, { name: CACHE, force: true, json: true }),
      (error: unknown) =>
        error instanceof CprojError &&
        error.code === 'VOLUME_IN_USE' &&
        /shared toolchain cache/.test(error.message) &&
        !/service remove/.test(error.message),
    )
    assert.deepEqual(docker.calls, [], 'Docker was never asked to remove it')
  })

  test('`delete --purge` takes the project’s data and leaves the cache', async () => {
    const box = sandbox()
    const docker = stubDocker({
      volumes: [
        { name: CACHE, labels: { 'cproj.role': 'cache' } },
        { name: 'cproj-droid-home', labels: { 'cproj.project': 'droid', 'cproj.role': 'home' } },
        { name: 'droid_pgdata', labels: { 'cproj.project': 'droid', 'cproj.service': 'postgres' } },
      ],
    })
    const ctx = makeContext(box, docker)
    await runNew(ctx, { name: 'droid', archetype: 'android', services: 'postgres' })

    await runDelete(ctx, { name: 'droid', force: true, keepData: false, purge: true, json: true })
    const removed = docker.calls.filter((call) => call.kind === 'removeVolume').map((call) => call.name)
    assert.deepEqual(
      removed,
      ['cproj-droid-home', 'droid_pgdata'],
      'purge destroys what the project owns — its home included — not what it shares',
    )
  })
})
