/**
 * The base images: the archetype map, build args, the architecture pin, the shared caches.
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { BardolierError } from '../cli/src/errors.ts'
import { validate } from '../cli/src/schema.ts'
import { renderCompose } from '../cli/src/compose.ts'
import { seededFiles } from '../cli/src/scaffold.ts'
import { baseImages, IMAGE_CACHE, IMAGE_PLATFORM, CONTAINER_HOME } from '../cli/src/images.ts'
import { runNew } from '../cli/src/commands/new.ts'
import { runUp } from '../cli/src/commands/up.ts'
import { runDelete } from '../cli/src/commands/delete.ts'
import { runBuild } from '../cli/src/commands/build.ts'
import { ARCHETYPES, ARCHETYPE_BASE_IMAGE, BASE_IMAGES } from '../cli/src/model/archetype.ts'
import { runVolumeRemove } from '../cli/src/commands/volumes.ts'
import { scanVolumes } from '../cli/src/volumes.ts'
import {
  catalogue,
  dockerfile,
  labels,
  makeContext,
  manifest,
  project,
  sandboxes,
  stubDocker,
} from './helpers.ts'

const sandbox = sandboxes()

// ── build (§6 Images) ─────────────────────────────────────────────────────────
describe('build (cli-spec.md §6, Images)', () => {
  test('builds the web base with the host UID/GID as build args', async () => {
    const box = sandbox()
    const docker = stubDocker()
    const result = await runBuild(makeContext(box, docker), 'web')

    assert.ok(validate('build', result).valid, 'build output must match build.schema.json')
    assert.equal(result.uid, 501)
    assert.equal(result.gid, 20)
    assert.deepEqual(result.images.map((i) => [i.image, i.status]), [['bardolier-web', 'built']])

    const call = docker.calls[0]
    assert.ok(call?.kind === 'build')
    assert.equal(call.request.tag, 'bardolier-web:latest')
    assert.deepEqual(call.request.args, { HOST_UID: '501', HOST_GID: '20', CLAUDE_CODE_VERSION: 'latest' })
    assert.ok(call.request.dockerfile.endsWith(join('bardolier-web', 'Dockerfile')))
  })

  test('`library` shares the web base, per the §4.3 map', async () => {
    const box = sandbox()
    const docker = stubDocker()
    const result = await runBuild(makeContext(box, docker), 'library')
    assert.deepEqual(result.images.map((i) => i.image), ['bardolier-web'])
    assert.deepEqual(result.images[0]?.archetypes, ['web', 'library'])
  })

  test('no argument builds every base image, in §4.3 order', async () => {
    const box = sandbox()
    const result = await runBuild(makeContext(box, stubDocker()), undefined)
    assert.deepEqual(
      result.images.map((i) => [i.image, i.status]),
      [
        ['bardolier-web', 'built'],
        ['bardolier-ios', 'built'],
        ['bardolier-and', 'built'],
      ],
    )
    for (const image of result.images) {
      if (image.status === 'unavailable') assert.ok(image.reason, `${image.image} was skipped without saying why`)
    }
  })

  test('an image with no Dockerfile behind it is described, not thrown away', () => {
    // The state `build` reports as `unavailable`: reachable through the images
    // root, which is what makes a deleted or not-yet-written Dockerfile an
    // explanation rather than a crash.
    const box = sandbox()
    for (const definition of baseImages(join(box.root, 'no-images'))) {
      assert.equal(definition.dockerfile, null)
    }
  })

  test('a dead daemon is DOCKER_UNAVAILABLE, and an unknown archetype is refused', async () => {
    const box = sandbox()
    await assert.rejects(
      () => runBuild(makeContext(box, stubDocker({ available: false })), 'web'),
      (error: unknown) => error instanceof BardolierError && error.code === 'DOCKER_UNAVAILABLE',
    )
    await assert.rejects(
      () => runBuild(makeContext(box, stubDocker()), 'toaster'),
      (error: unknown) => error instanceof BardolierError && error.code === 'INVALID_ARGUMENT',
    )
  })

  test('build works with the SSD unplugged — images live on the internal disk', async () => {
    const box = sandbox()
    const ctx = makeContext(box, stubDocker(), { env: { BARDOLIER_ROOT: join(box.root, 'unplugged') } })
    const result = await runBuild(ctx, 'web')
    assert.equal(result.images[0]?.status, 'built')
  })

  test('the base image the doctor looks for is the one build produces', () => {
    const web = baseImages().find((image) => image.image === 'bardolier-web')
    assert.ok(web?.dockerfile, 'the bardolier-web Dockerfile is missing from the install')
    const dockerfile = readFileSync(web.dockerfile, 'utf8')
    // The build args are the contract between build.ts and the Dockerfile.
    assert.ok(dockerfile.includes('ARG HOST_UID'))
    assert.ok(dockerfile.includes('ARG HOST_GID'))
    assert.ok(dockerfile.includes('WORKDIR /work'))
  })
})

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
    assert.equal(ARCHETYPE_BASE_IMAGE.ios, 'bardolier-ios')
    assert.equal(ARCHETYPE_BASE_IMAGE.android, 'bardolier-and')
  })

  test('`build` with no argument reports nothing unavailable', async () => {
    const box = sandbox()
    const docker = stubDocker()
    const result = await runBuild(makeContext(box, docker), undefined)

    assert.ok(validate('build', result).valid, 'build output must match build.schema.json')
    assert.deepEqual(
      result.images.map((image) => [image.image, image.status]),
      [
        ['bardolier-web', 'built'],
        ['bardolier-ios', 'built'],
        ['bardolier-and', 'built'],
      ],
    )
    // Every build carries the host identity — the point of the command —
    // plus the Claude Code pin, defaulted to `latest`.
    for (const call of docker.calls) {
      assert.ok(call.kind === 'build')
      assert.deepEqual(call.request.args, { HOST_UID: '501', HOST_GID: '20', CLAUDE_CODE_VERSION: 'latest' })
    }
  })

  test('`build --archetype ios` and `--archetype android` reach their own Dockerfiles', async () => {
    for (const [archetype, image] of [
      ['ios', 'bardolier-ios'],
      ['android', 'bardolier-and'],
    ] as const) {
      const box = sandbox()
      const docker = stubDocker()
      const result = await runBuild(makeContext(box, docker), archetype)
      assert.deepEqual(result.images.map((entry) => entry.image), [image])

      const call = docker.calls[0]
      assert.ok(call?.kind === 'build')
      assert.equal(call.request.tag, `${image}:latest`)
      assert.ok(call.request.dockerfile.endsWith(join(image, 'Dockerfile')))
    }
  })
})

// ── The build-arg contract every base image keeps ─────────────────────────────
describe('the base images keep the ownership contract (HOST_UID/HOST_GID)', () => {
  for (const image of BASE_IMAGES) {
    test(`${image} takes the host identity and works at /work as that user`, () => {
      const text = dockerfile(image)
      // These four are what `bardolier build` and `compose.ts` assume between them.
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
describe('bardolier-and is pinned to linux/amd64, consistently (images.ts)', () => {
  test('only the android base is pinned, and it is pinned to x86_64', () => {
    assert.deepEqual(IMAGE_PLATFORM, { 'bardolier-and': 'linux/amd64' })
    const byImage = Object.fromEntries(baseImages().map((d) => [d.image, d.platform]))
    assert.deepEqual(byImage, {
      'bardolier-web': null,
      'bardolier-ios': null,
      'bardolier-and': 'linux/amd64',
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
      'bardolier-web': null,
      'bardolier-ios': null,
      'bardolier-and': 'linux/amd64',
    })
  })

  test('the generated compose file starts the dev container on the same platform', () => {
    const services = catalogue(sandbox())
    const android = renderCompose({ manifest: manifest('droid', { archetype: 'android', base_image: 'bardolier-and' }), catalogue: services })
    assert.match(android, /platform: linux\/amd64/)

    // …and adds nothing for an unpinned image, so no existing project's
    // generated file gains a diff (§9 determinism).
    const web = renderCompose({ manifest: manifest('site'), catalogue: services })
    assert.ok(!web.includes('platform:'), 'an unpinned base image must not emit a platform key')

    // Same manifest, same bytes — the pin is not a new source of drift.
    assert.equal(android, renderCompose({ manifest: manifest('droid', { archetype: 'android', base_image: 'bardolier-and' }), catalogue: services }))
  })

  test('`new android` writes a compose file the daemon can actually start', async () => {
    const box = sandbox()
    await runNew(makeContext(box), { name: 'droid', archetype: 'android', services: undefined })
    const compose = readFileSync(join(box.root, 'droid', 'docker-compose.yml'), 'utf8')
    assert.match(compose, /image: bardolier-and:latest/)
    assert.match(compose, /platform: linux\/amd64/)
  })
})

// ── Claude Code defaults to `latest`; `--claude-code-version` pins it ─────────
describe('`build --claude-code-version` (default `latest`, pin with an exact release)', () => {
  test('unset defaults to `latest`, passed to every image and reported in the output', async () => {
    const box = sandbox()
    const docker = stubDocker()
    const result = await runBuild(makeContext(box, docker), undefined)
    assert.deepEqual(
      result.images.map((image) => image.claudeCodeVersion),
      ['latest', 'latest', 'latest'],
    )
    for (const call of docker.calls) {
      assert.ok(call.kind === 'build')
      assert.deepEqual(call.request.args, { HOST_UID: '501', HOST_GID: '20', CLAUDE_CODE_VERSION: 'latest' })
    }
  })

  test('an exact `X.Y.Z` pins it instead, passed through to every image and the output', async () => {
    const box = sandbox()
    const docker = stubDocker()
    const result = await runBuild(makeContext(box, docker), undefined, '2.1.999')
    assert.deepEqual(
      result.images.map((image) => image.claudeCodeVersion),
      ['2.1.999', '2.1.999', '2.1.999'],
    )
    for (const call of docker.calls) {
      assert.ok(call.kind === 'build')
      assert.equal(call.request.args.CLAUDE_CODE_VERSION, '2.1.999')
    }
  })

  test('rejects anything that is not `latest` or `X.Y.Z`', async () => {
    const box = sandbox()
    await assert.rejects(
      () => runBuild(makeContext(box, stubDocker()), undefined, 'v2.1.247'),
      (error: unknown) => error instanceof BardolierError && error.code === 'INVALID_ARGUMENT',
    )
  })
})

// ── The boundary, as a fact about the image ───────────────────────────────────
describe('the mobile images encode the host/container boundary (CLAUDE.md)', () => {
  test('bardolier-ios carries the Swift toolchain and swiftlint, and no host-only build', () => {
    const text = dockerfile('bardolier-ios')
    assert.match(text, /^FROM swift:/m, 'the ios base must be the open-source Swift toolchain')
    assert.match(text, /swiftlint/, 'swiftlint is half of what the ios archetype can do in here (§4.3)')
    // Nothing in here may look like a way to build the app: those steps are the
    // human's, on the Mac.
    assert.ok(!/^\s*RUN[^\n]*xcodebuild/m.test(text), 'the ios base must not invoke xcodebuild')
    assert.ok(!/simulator|xcrun simctl/i.test(text.replace(/^#.*$/gm, '')), 'no simulator belongs in a Linux image')
  })

  test('bardolier-and carries the SDK and Gradle, and no adb', () => {
    const text = dockerfile('bardolier-and')
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
    assert.match(dockerfile('bardolier-web'), /ARG NODE_VERSION=\d/)
    assert.match(dockerfile('bardolier-ios'), /ARG SWIFT_VERSION=\d/)
    assert.match(dockerfile('bardolier-ios'), /ARG SWIFTLINT_VERSION=\d/)
    const android = dockerfile('bardolier-and')
    for (const arg of ['JAVA_VERSION', 'ANDROID_CMDLINE_TOOLS', 'ANDROID_PLATFORM', 'ANDROID_BUILD_TOOLS', 'GRADLE_VERSION']) {
      assert.match(android, new RegExp(`ARG ${arg}=`), `${arg} is not pinned`)
    }
  })

  test('the seeded CLAUDE.md steers the agent the same way the image does (§10)', () => {
    const ios = seededFiles('myapp', 'ios').find((file) => file.name === 'work/CLAUDE.md')?.contents ?? ''
    assert.match(ios, /xcodebuild/, 'the ios note must name the command it is forbidding')
    assert.match(ios, /swiftlint/, 'and what the container CAN do instead')
    assert.match(ios, /logic tests/)

    const android = seededFiles('myapp', 'android').find((file) => file.name === 'work/CLAUDE.md')?.contents ?? ''
    assert.match(android, /Gradle builds and unit tests \*\*run in this container\*\*/)
    assert.match(android, /adb/, 'the android note must name adb, which the image does not carry')
  })
})

// ── The Gradle cache: shared, and on the internal disk ────────────────────────
describe('toolchain caches are shared, not per project (images.ts)', () => {
  const CACHE = 'bardolier-gradle-cache'
  const MOUNT = '/cache/gradle'
  const UV_CACHE = 'bardolier-uv-cache'
  const UV_MOUNT = '/cache/uv'

  /** A manifest for an android project, which shares Gradle's cache. */
  function droid(name = 'droid') {
    return manifest(name, { archetype: 'android', base_image: 'bardolier-and' })
  }

  /** A manifest for the one archetype with no cache at all. */
  function swiftbits(name = 'swiftbits') {
    return manifest(name, { archetype: 'ios', base_image: 'bardolier-ios' })
  }

  test('two images declare a cache, and each Dockerfile puts its toolchain in it', () => {
    assert.deepEqual(IMAGE_CACHE, {
      'bardolier-web': { volume: UV_CACHE, mount: UV_MOUNT },
      'bardolier-and': { volume: CACHE, mount: MOUNT },
    })
    const byImage = Object.fromEntries(baseImages().map((d) => [d.image, d.cache?.volume ?? null]))
    assert.deepEqual(byImage, { 'bardolier-web': UV_CACHE, 'bardolier-ios': null, 'bardolier-and': CACHE })

    // The coupling that a wrong answer makes silent: a toolchain writing
    // somewhere the volume is not mounted still WORKS — it just re-downloads
    // every run, into a container layer, which is the thing this exists to stop.
    for (const [image, envVar, mount] of [
      ['bardolier-and', 'GRADLE_USER_HOME', MOUNT],
      ['bardolier-web', 'UV_CACHE_DIR', UV_MOUNT],
    ] as const) {
      const text = dockerfile(image)
      assert.match(text, new RegExp(`ENV ${envVar}=${mount}\\b`))
      assert.ok(!new RegExp(`${envVar}=/work`).test(text), 'a per-project cache would sit on the SSD')
      // Docker seeds a new named volume from the image's directory, ownership
      // and all, and there is no sudo in there to fix a root-owned mount after.
      assert.match(text, new RegExp(`mkdir -p[^\\n]*${mount}`))
      assert.match(text, /chown -R "\$\{HOST_UID\}:\$\{HOST_GID\}"[^\n]*\/cache/)
    }
  })

  test('the compose file mounts each, and lets Compose neither create nor claim them', () => {
    const services = catalogue(sandbox())
    const android = renderCompose({ manifest: droid(), catalogue: services })
    assert.match(android, new RegExp(`- ${CACHE}:${MOUNT}`))
    // `external: true` is the whole trick: a Compose-created volume carries the
    // FIRST project's compose labels, and every other project on that image
    // then warns about it on every `up`.
    assert.match(android, new RegExp(`${CACHE}:\\n\\s+name: ${CACHE}\\n\\s+external: true`))
    assert.ok(!android.includes('bardolier.project: droid\n    bardolier.service'), 'the cache is no project’s volume')
    assert.ok(!android.includes(UV_CACHE), 'android shares no volume with the web image')

    const web = renderCompose({ manifest: manifest('site'), catalogue: services })
    assert.match(web, new RegExp(`- ${UV_CACHE}:${UV_MOUNT}`))
    assert.match(web, new RegExp(`${UV_CACHE}:\\n\\s+name: ${UV_CACHE}\\n\\s+external: true`))
    assert.ok(!web.includes(CACHE), 'web shares no volume with the android image')

    // Nothing changes for the one image with no cache — no mount, no volumes key.
    const ios = renderCompose({ manifest: swiftbits(), catalogue: services })
    assert.ok(!ios.includes(CACHE) && !ios.includes(UV_CACHE), 'an image with no cache must not gain one')
    // And since phase 19 there is nothing else to declare: a project's data and
    // its `$HOME` are directories inside it, so the cache was the last volume.
    assert.doesNotMatch(ios, /\nvolumes:\n/, 'an image with no cache declares no volumes block at all')

    // Same manifest, same bytes (§9).
    assert.equal(android, renderCompose({ manifest: droid(), catalogue: services }))
  })

  test('`up` creates each cache volume before Compose asks for it, and only for its own image', async () => {
    const box = sandbox()
    const docker = stubDocker({ startsAs: ['bardolier-droid'] })
    const ctx = makeContext(box, docker)
    await runNew(ctx, { name: 'droid', archetype: 'android', services: undefined })
    await runUp(ctx, { name: 'droid', noShell: true })

    const kinds = docker.calls.map((call) => call.kind)
    assert.deepEqual(kinds, ['ensureVolume', 'up'], 'an external volume must exist before `compose up` runs')
    const created = docker.calls.find((call) => call.kind === 'ensureVolume')
    assert.equal(created?.kind === 'ensureVolume' ? created.name : null, CACHE)
    // Labelled as the cache, and NOT as any project's: that label is what makes
    // the orphan scan treat it as shared rather than as `droid`'s to reclaim.
    assert.deepEqual(created?.kind === 'ensureVolume' ? created.labels : null, { 'bardolier.role': 'cache' })

    const web = stubDocker({ startsAs: ['bardolier-site'] })
    const webCtx = makeContext(sandbox(), web)
    await runNew(webCtx, { name: 'site', archetype: 'web', services: undefined })
    await runUp(webCtx, { name: 'site', noShell: true })
    const webCreated = web.calls.find((call) => call.kind === 'ensureVolume')
    assert.equal(webCreated?.kind === 'ensureVolume' ? webCreated.name : null, UV_CACHE)

    const ios = stubDocker({ startsAs: ['bardolier-swiftbits'] })
    const iosCtx = makeContext(sandbox(), ios)
    await runNew(iosCtx, { name: 'swiftbits', archetype: 'ios', services: undefined })
    await runUp(iosCtx, { name: 'swiftbits', noShell: true })
    assert.deepEqual(ios.calls.map((call) => call.kind), ['up'], 'ios needs no cache volume at all')
  })

  test('it is claimed while any android project exists, and reclaimable once none does', async () => {
    const box = sandbox()
    const docker = stubDocker({ volumes: [{ name: CACHE, labels: { 'bardolier.role': 'cache' }, size_bytes: 20971520 }] })
    const ctx = makeContext(box, docker)
    await runNew(ctx, { name: 'droid', archetype: 'android', services: undefined })
    await runNew(ctx, { name: 'site', archetype: 'web', services: undefined })

    const held = await scanVolumes(ctx)
    assert.deepEqual(held.orphans, [], 'a cache a project still builds with is not disk to reclaim')
    assert.equal(held.claimedBy.get(CACHE), 'droid')

    // The last android project goes, and with it the only reason to keep it.
    await runDelete(ctx, { name: 'droid', force: true, purge: false, json: true })
    const freed = await scanVolumes(ctx)
    assert.deepEqual(freed.orphans.map((orphan) => orphan.name), [CACHE])
    // No project made it, so none is named as its last — the schema allows that
    // and inventing one would be a lie about where the data came from.
    assert.equal(freed.orphans[0]?.last_project, null)
    assert.equal(freed.orphans[0]?.size_human, '20 MB')
  })

  test('`volumes rm` refuses it with the reason that fits a shared volume', async () => {
    const box = sandbox()
    const docker = stubDocker({ volumes: [{ name: CACHE, labels: { 'bardolier.role': 'cache' }, size_bytes: 1024 }] })
    const ctx = makeContext(box, docker)
    await runNew(ctx, { name: 'droid', archetype: 'android', services: undefined })

    // Refused before Docker is asked, and with an instruction that fits: there
    // is no service to detach from a volume no service owns.
    await assert.rejects(
      () => runVolumeRemove(ctx, { name: CACHE, force: true, json: true }),
      (error: unknown) =>
        error instanceof BardolierError &&
        error.code === 'VOLUME_IN_USE' &&
        /shared toolchain cache/.test(error.message) &&
        !/service remove/.test(error.message),
    )
    assert.deepEqual(docker.calls, [], 'Docker was never asked to remove it')
  })

  test('`delete --purge` takes the project’s data and never touches the cache', async () => {
    const box = sandbox()
    const docker = stubDocker({ volumes: [{ name: CACHE, labels: { 'bardolier.role': 'cache' } }] })
    const ctx = makeContext(box, docker)
    await runNew(ctx, { name: 'droid', archetype: 'android', services: 'postgres' })

    await runDelete(ctx, { name: 'droid', force: true, purge: true, json: true })

    assert.equal(box.exists('droid'), false, 'the data and the home went with the directory (phase 19)')
    assert.deepEqual(
      docker.calls.filter((call) => call.kind === 'removeVolume'),
      [],
      'the cache is shared by every project on the image; purging one must not take it',
    )
    assert.deepEqual(await docker.volumeNames(), [CACHE])
  })
})

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
      // ssh expands `~` from the passwd entry rather than $HOME, so a fourth
      // reader has to agree: otherwise a key at $HOME/.ssh is invisible to it.
      assert.match(dockerfile(image), new RegExp(`usermod -d ${CONTAINER_HOME}\\b`), `${image}`)
    }
  })
})
