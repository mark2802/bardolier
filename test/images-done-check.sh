#!/usr/bin/env bash
# The base images: the §4.3 map complete, the build-arg contract, the
# architecture pin, the shared toolchain caches, and a real project built and
# tested inside each — including the Python half of `bardolier-web`.
#
#   bash test/images-done-check.sh
#   BARDOLIER_SKIP_DOCKER=1 …    offline assertions only
#   VERBOSE=1 …                  print every passing line
set -uo pipefail

source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
sandbox

track bardolier-mobile bardolier-droid bardolier-pyweb
track_volume bardolier-mobile-home bardolier-droid-home bardolier-pyweb-home

# ── 1. The §4.3 map is complete ───────────────────────────────────────────────
head "1. Every archetype has a base image (§4.3)"

if node --input-type=module -e "
  import assert from 'node:assert/strict'
  import { baseImages } from './cli/src/images.ts'
  for (const image of baseImages()) {
    assert.ok(image.dockerfile, image.image + ' has no Dockerfile')
  }
" 2>/dev/null; then
  ok "bardolier-web, bardolier-ios and bardolier-and all have a Dockerfile on disk"
else
  bad 'a base image declared in §4.3 has no Dockerfile — build would report it unavailable'
fi

if npm test >/dev/null 2>&1; then ok "npm test — including test/phase8.test.ts"; else bad "npm test"; fi
if npm run typecheck >/dev/null 2>&1; then ok "npm run typecheck"; else bad "npm run typecheck"; fi

# ── 2. The images themselves ──────────────────────────────────────────────────
head "2. Base images"

if ! docker_ready; then
  summary "Images"
  exit 0
fi
ok "the Docker daemon responded"

have_image() { docker image inspect "$1:latest" >/dev/null 2>&1; }

for pair in "ios:bardolier-ios" "android:bardolier-and"; do
  archetype="${pair%%:*}"
  image="${pair##*:}"
  if have_image "$image"; then
    ok "$image:latest is present"
  elif [ "${PHASE8_NO_BUILD:-0}" = "1" ]; then
    bad "$image:latest is missing and PHASE8_NO_BUILD=1 — run \`bardolier build --archetype $archetype\`"
  else
    printf '    building %s (this is the slow part; ^C is safe)\n' "$image"
    if $BARDOLIER build --archetype "$archetype" >"$TMP/build-$archetype.log" 2>&1; then
      ok "$image:latest built from cli/images/$image/Dockerfile"
    else
      bad "\`bardolier build --archetype $archetype\` failed:"
      tail -5 "$TMP/build-$archetype.log" | sed 's/^/      /'
    fi
  fi
done

# The host identity is the whole reason `build` exists rather than `docker build`.
HOST_UID="$(id -u)"
HOST_GID="$(id -g)"
if BUILD="$($BARDOLIER build --archetype web --json 2>/dev/null)" \
  && json_assert "$BUILD" "d.uid === $HOST_UID && d.gid === $HOST_GID"; then
  ok "build passes this Mac's uid/gid ($HOST_UID:$HOST_GID) as build args"
else
  bad "build did not report the host identity"
fi

# ── 3. An ios project, from `new` to a test run ───────────────────────────────
head "3. ios — Swift toolchain, swiftlint, and no way to build the app (§4.3)"

$BARDOLIER new swiftbits --archetype ios >/dev/null || bad "\`bardolier new --archetype ios\` failed"
IOS_DIR="$MOUNTED/swiftbits"

if [ -f "$IOS_DIR/docker-compose.yml" ] && grep -q "image: bardolier-ios:latest" "$IOS_DIR/docker-compose.yml"; then
  ok "the generated compose file starts the ios base image"
else
  bad "the ios project's compose file does not use bardolier-ios"
fi

CLAUDE_MD="$IOS_DIR/work/CLAUDE.md"
if grep -q "xcodebuild" "$CLAUDE_MD" && grep -qi "never run" "$CLAUDE_MD" && grep -q "swiftlint" "$CLAUDE_MD"; then
  ok "its seeded CLAUDE.md forbids xcodebuild/Simulator/signing and points at what does work here"
else
  bad "the ios CLAUDE.md does not steer the agent away from host-only build steps (§10)"
fi

if $BARDOLIER up swiftbits --no-shell >/dev/null 2>&1; then
  ok "bardolier up swiftbits"
else
  bad "bardolier up swiftbits failed"
fi

IOS_CONTAINER="$($BARDOLIER status swiftbits --json 2>/dev/null | node -e "
  let s = ''
  process.stdin.on('data', (c) => (s += c)).on('end', () => {
    const d = JSON.parse(s)
    process.stdout.write(d.projects[0]?.dev_container ?? '')
  })
")"
if [ -n "$IOS_CONTAINER" ]; then
  ok "status names its dev container ($IOS_CONTAINER) — what the app and this check both use"
else
  bad "status did not report a dev container for swiftbits"
fi

in_ios() { docker exec "$IOS_CONTAINER" bash -lc "$1"; }

if [ -n "$IOS_CONTAINER" ]; then
  if SWIFT="$(in_ios 'swift --version 2>&1 | head -1')"; then
    ok "the container has the Swift toolchain: $SWIFT"
  else
    bad "no working swift in the ios container"
  fi

  if LINT="$(in_ios 'swiftlint version 2>&1 | tail -1')"; then
    ok "swiftlint $LINT is installed"
  else
    bad "swiftlint is missing — half of what §4.3 says the ios container can do"
  fi

  # The boundary as a fact about the image, not only as advice in CLAUDE.md.
  if in_ios 'command -v xcodebuild' >/dev/null 2>&1; then
    bad "there is an xcodebuild in the container — the boundary must be unreachable, not just discouraged"
  else
    ok "no xcodebuild, no simctl: the host-only steps cannot be attempted from in here"
  fi

  if [ "${IMAGES_QUICK:-0}" = "1" ]; then
    skip "IMAGES_QUICK=1 — skipped swift build / swift test / swiftlint on a real package"
  else
    if in_ios 'swift package init --type library --name Widget >/dev/null 2>&1 && swift build >/dev/null 2>&1 && swift test 2>&1 | tail -1' \
        >"$TMP/swift.log" 2>&1 && grep -qi "passed" "$TMP/swift.log"; then
      ok "swift build and swift test run a real package's logic tests in-container"
    else
      bad "swift build/test failed in the ios container:"
      tail -5 "$TMP/swift.log" | sed 's/^/      /'
    fi

    # A SourceKit-dependent rule being silently skipped means the lint checks
    # less than it claims (see the Dockerfile's note on the static binary).
    if in_ios 'swiftlint lint --quiet Sources' >"$TMP/lint.log" 2>&1; then
      if grep -qi "SourceKit access is prohibited" "$TMP/lint.log"; then
        bad "swiftlint is running without SourceKit — its type-aware rules are silently disabled"
      else
        ok "swiftlint lints the package with its SourceKit rules enabled"
      fi
    else
      bad "swiftlint could not lint the package:"
      tail -3 "$TMP/lint.log" | sed 's/^/      /'
    fi

    # The reason HOST_UID/HOST_GID exist at all.
    if in_ios 'touch /work/written-by-the-agent' >/dev/null 2>&1; then
      OWNER="$(stat -f '%u' "$IOS_DIR/work/written-by-the-agent" 2>/dev/null || echo '?')"
      if [ "$OWNER" = "$HOST_UID" ]; then
        ok "a file the container writes into /work comes back owned by you ($HOST_UID)"
      else
        bad "the container wrote /work as uid $OWNER, not $HOST_UID — the bind mount is not yours"
      fi
    else
      bad "the container could not write to /work"
    fi
  fi
fi

$BARDOLIER down swiftbits >/dev/null 2>&1 || true

# ── 4. An android project, built and tested by Gradle ─────────────────────────
head "4. android — a real Gradle build and unit test in-container (§4.3)"

$BARDOLIER new droid --archetype android >/dev/null || bad "\`bardolier new --archetype android\` failed"
AND_DIR="$MOUNTED/droid"

if grep -q "platform: linux/amd64" "$AND_DIR/docker-compose.yml"; then
  ok "the compose file pins the dev container to linux/amd64, as \`build\` built it (images.ts)"
else
  bad "the android compose file has no platform pin — aapt2 is x86_64-only, so the build would fail"
fi

if grep -q "bardolier-gradle-cache:/cache/gradle" "$AND_DIR/docker-compose.yml" \
  && grep -q "external: true" "$AND_DIR/docker-compose.yml"; then
  ok "and mounts the shared Gradle cache as an external volume (§4.3, §9)"
else
  bad "the android compose file does not mount bardolier-gradle-cache as an external volume"
fi

if grep -qi "emulator" "$AND_DIR/work/CLAUDE.md" && grep -q "adb" "$AND_DIR/work/CLAUDE.md"; then
  ok "its seeded CLAUDE.md keeps the emulator and adb on the host side (§10)"
else
  bad "the android CLAUDE.md does not name the host-side boundary"
fi

# A minimal but real Android application module: resources compiled by aapt2,
# an APK linked, and a JVM unit test — the three things the archetype promises.
mkdir -p "$AND_DIR/work/app/src/main" "$AND_DIR/work/app/src/test/java/com/example/droid"
cat > "$AND_DIR/work/settings.gradle" <<'GRADLE'
pluginManagement { repositories { google(); mavenCentral(); gradlePluginPortal() } }
dependencyResolutionManagement { repositories { google(); mavenCentral() } }
rootProject.name = 'droid'
include ':app'
GRADLE
cat > "$AND_DIR/work/app/build.gradle" <<'GRADLE'
plugins { id 'com.android.application' version '9.0.1' }
android {
    namespace 'com.example.droid'
    compileSdk 36
    defaultConfig {
        applicationId 'com.example.droid'
        minSdk 24
        targetSdk 36
        versionCode 1
        versionName '1.0'
    }
    compileOptions {
        sourceCompatibility JavaVersion.VERSION_17
        targetCompatibility JavaVersion.VERSION_17
    }
}
dependencies { testImplementation 'junit:junit:4.13.2' }
GRADLE
cat > "$AND_DIR/work/app/src/main/AndroidManifest.xml" <<'XML'
<?xml version="1.0" encoding="utf-8"?>
<manifest xmlns:android="http://schemas.android.com/apk/res/android">
    <application android:label="droid" />
</manifest>
XML
cat > "$AND_DIR/work/app/src/test/java/com/example/droid/MathTest.java" <<'JAVA'
package com.example.droid;
import org.junit.Test;
import static org.junit.Assert.assertEquals;
public class MathTest {
    @Test public void adds() { assertEquals(4, 2 + 2); }
}
JAVA

if $BARDOLIER up droid --no-shell >/dev/null 2>&1; then
  ok "bardolier up droid"
else
  bad "bardolier up droid failed"
fi

# `up` creates the volume Compose was told is external — nobody else can, and
# without it `compose up` fails outright rather than silently.
if docker volume inspect bardolier-gradle-cache >/dev/null 2>&1; then
  ok "bardolier up created the shared cache volume"
  ROLE="$(docker volume inspect bardolier-gradle-cache --format '{{index .Labels "bardolier.role"}}' 2>/dev/null)"
  if [ "$ROLE" = "cache" ]; then
    ok "labelled bardolier.role=cache, so the orphan scan knows it belongs to no project"
  else
    bad "the cache volume is labelled '$ROLE' — the volume scan would misattribute it"
  fi
else
  bad "bardolier up did not create bardolier-gradle-cache"
fi

AND_CONTAINER="$($BARDOLIER status droid --json 2>/dev/null | node -e "
  let s = ''
  process.stdin.on('data', (c) => (s += c)).on('end', () => {
    const d = JSON.parse(s)
    process.stdout.write(d.projects[0]?.dev_container ?? '')
  })
")"
in_and() { docker exec "$AND_CONTAINER" bash -lc "$1"; }

if [ -n "$AND_CONTAINER" ]; then
  ARCH="$(in_and 'uname -m' 2>/dev/null | tr -d '\r\n')"
  if [ "$ARCH" = "x86_64" ]; then
    ok "the dev container runs x86_64, which is the only architecture Google ships aapt2 for"
  else
    bad "the android dev container came up $ARCH — the platform pin did not reach compose"
  fi

  if in_and 'command -v adb' >/dev/null 2>&1; then
    bad "adb is installed — the emulator/device boundary must be unreachable from in here"
  else
    ok "no adb: instrumented tests and device installs stay on the Mac"
  fi

  if SDK="$(in_and 'sdkmanager --list_installed 2>/dev/null | grep -cE "build-tools|platforms"')" && [ "${SDK:-0}" -ge 2 ]; then
    ok "the Android SDK has a platform and build-tools installed"
  else
    bad "the SDK is incomplete — sdkmanager lists no platform/build-tools"
  fi

  if [ "${IMAGES_QUICK:-0}" = "1" ]; then
    skip "IMAGES_QUICK=1 — skipped the Gradle build (the slow one: emulated, and it downloads AGP)"
  else
    printf '    running gradle assembleDebug + testDebugUnitTest (minutes, emulated)\n'
    if in_and 'gradle --no-daemon :app:assembleDebug :app:testDebugUnitTest' >"$TMP/gradle.log" 2>&1; then
      ok "gradle assembleDebug + testDebugUnitTest succeeded in-container"
    else
      bad "the Gradle build failed:"
      tail -8 "$TMP/gradle.log" | sed 's/^/      /'
    fi

    # The point of the volume: the downloads landed in it, not on the SSD, so
    # the next project (and the next run of this check) does not pay for them
    # again. `--offline` is the honest test of that — it fails if anything it
    # needs is missing from the cache.
    if in_and 'test -d "$GRADLE_USER_HOME/caches/modules-2" && test -n "$(ls -A "$GRADLE_USER_HOME/caches/modules-2")"' >/dev/null 2>&1; then
      ok "the downloaded dependencies are in the shared volume, not under /work"
    else
      bad "GRADLE_USER_HOME holds no downloaded modules — the cache is not where the volume is"
    fi

    if in_and 'test -d /work/.gradle/caches/modules-2' >/dev/null 2>&1; then
      bad "a per-project dependency cache is on the SSD at .gradle/caches — that is what the volume replaced"
    else
      ok "nothing re-created a per-project dependency cache on the SSD"
    fi

    if in_and 'gradle --no-daemon --offline :app:assembleDebug' >"$TMP/gradle-offline.log" 2>&1; then
      ok "a second build runs --offline: the cache is warm, which is the whole point"
    else
      bad "the offline rebuild failed — the cache did not survive the first build:"
      tail -5 "$TMP/gradle-offline.log" | sed 's/^/      /'
    fi

    APK=""
    for candidate in "$AND_DIR"/work/app/build/outputs/apk/debug/*.apk; do
      [ -f "$candidate" ] && APK="$candidate" && break
    done
    if [ -n "$APK" ]; then
      ok "an APK is in work/, written through the bind mount: $(basename "$APK")"
      OWNER="$(stat -f '%u' "$APK" 2>/dev/null || echo '?')"
      if [ "$OWNER" = "$HOST_UID" ]; then
        ok "and it belongs to you ($HOST_UID), not to root"
      else
        bad "the APK is owned by uid $OWNER — HOST_UID did not reach the image"
      fi
    else
      bad "no APK was produced — aapt2 is the usual reason on the wrong architecture"
    fi
  fi
fi

$BARDOLIER down droid >/dev/null 2>&1 || true

# ── 5. Nothing in the repo attempts a host-only step ──────────────────────────
head "5. The boundary holds in the tooling too (CLAUDE.md)"

# Naming these tools is the boundary being WRITTEN DOWN — in a comment, or in
# the seeded CLAUDE.md that scaffold.ts renders. Running one is the boundary
# being broken. So: strip comments, and hold scaffold.ts to the stronger rule
# below instead of grepping the very sentence it exists to write.
OFFENDERS="$(
  { find cli/src -name '*.ts' ! -name 'scaffold.ts'; ls cli/images/*/Dockerfile; } | while read -r file; do
    sed -e 's|//.*$||' -e 's|#.*$||' -e 's|^[[:space:]]*\*.*$||' "$file" \
      | grep -nE 'xcodebuild|xcrun|simctl' | sed "s|^|${file}:|" || true
  done
)"
if [ -n "$OFFENDERS" ]; then
  bad "something in the CLI or the images runs a host-only Xcode tool:"
  printf '%s\n' "$OFFENDERS" | sed 's/^/      /'
else
  ok "no code in the CLI or the base images invokes xcodebuild, xcrun or simctl"
fi

# scaffold.ts says `xcodebuild` because §10's boundary note has to name what it
# forbids. What makes that safe is that the module cannot run anything at all.
if grep -qE "child_process|spawn\(|execFile|process\.env" cli/src/scaffold.ts; then
  bad "scaffold.ts grew a way to reach the outside world — it renders text, nothing more"
else
  ok "the module that writes the boundary note has no way to execute anything"
fi

# ── 6. Build bardolier-web fresh, so this Dockerfile is the one running ─────────
head "6. bardolier-web, rebuilt with uv"

printf '    building bardolier-web (fast — a Node image)\n'
if $BARDOLIER build --archetype web >"$TMP/build.log" 2>&1; then
  ok "bardolier-web:latest built from cli/images/bardolier-web/Dockerfile"
else
  bad "\`bardolier build --archetype web\` failed:"
  tail -8 "$TMP/build.log" | sed 's/^/      /'
fi

# ── 7. A web project, up, with uv inside ──────────────────────────────────────
head "7. A Python API alongside the React frontend, in one dev container"

$BARDOLIER new pybits --archetype web >/dev/null || bad "\`bardolier new --archetype web\` failed"
DIR="$MOUNTED/pybits"

if grep -q "bardolier-uv-cache:/cache/uv" "$DIR/docker-compose.yml" && grep -q "external: true" "$DIR/docker-compose.yml"; then
  ok "the compose file mounts the shared uv cache as an external volume (§4.3, §9)"
else
  bad "the web project's compose file does not mount bardolier-uv-cache as an external volume"
fi

if grep -qi "proxy" "$DIR/work/CLAUDE.md"; then
  ok "its seeded CLAUDE.md says how a second process is reached (proxy, not a second port)"
else
  bad "the seeded CLAUDE.md is missing the proxy-not-a-second-port note"
fi

if $BARDOLIER up pybits --no-shell >/dev/null 2>&1; then
  ok "bardolier up pybits"
else
  bad "bardolier up pybits failed"
fi

if docker volume inspect bardolier-uv-cache >/dev/null 2>&1; then
  ok "bardolier up created the shared uv cache volume"
  ROLE="$(docker volume inspect bardolier-uv-cache --format '{{index .Labels "bardolier.role"}}' 2>/dev/null)"
  if [ "$ROLE" = "cache" ]; then
    ok "labelled bardolier.role=cache, so the orphan scan knows it belongs to no project"
  else
    bad "the cache volume is labelled '$ROLE' — the volume scan would misattribute it"
  fi
else
  bad "bardolier up did not create bardolier-uv-cache"
fi

CONTAINER="$($BARDOLIER status pybits --json 2>/dev/null | node -e "
  let s = ''
  process.stdin.on('data', (c) => (s += c)).on('end', () => {
    const d = JSON.parse(s)
    process.stdout.write(d.projects[0]?.dev_container ?? '')
  })
")"
in_c() { docker exec "$CONTAINER" bash -lc "$1"; }

if [ -n "$CONTAINER" ]; then
  if UVV="$(in_c 'uv --version 2>&1')"; then
    ok "the container has uv: $UVV"
  else
    bad "no working uv in the web container"
  fi

  if [ "${PHASE11_QUICK:-0}" = "1" ]; then
    skip "PHASE11_QUICK=1 — skipped uv python install and the offline-cache proof"
  else
    printf '    uv python install 3.12 (first run downloads an interpreter)\n'
    if in_c 'uv python install 3.12 >/dev/null 2>&1 && uv run --python 3.12 python3 -c "print(2 + 2)"' \
        >"$TMP/uv-python.log" 2>&1 && grep -q '^4$' "$TMP/uv-python.log"; then
      ok "uv python install + uv run actually execute Python 3.12"
    else
      bad "uv python install/run failed:"
      tail -5 "$TMP/uv-python.log" | sed 's/^/      /'
    fi

    if in_c 'test -n "$(find /cache/uv/python -mindepth 1 -maxdepth 1 2>/dev/null)"'; then
      ok "the managed Python interpreter landed in the shared volume, not under /work"
    else
      bad "UV_PYTHON_INSTALL_DIR holds nothing — the interpreter is not where the volume is"
    fi

    if in_c 'cd /work && uv venv >/dev/null 2>&1 && uv pip install --python .venv six >/dev/null 2>&1'; then
      ok "a project venv installs a real package via uv"
    else
      bad "uv venv / uv pip install failed in the container"
    fi

    if in_c 'test -n "$(find /cache/uv -maxdepth 1 -name "*.lock" -o -maxdepth 2 -type d -name wheels 2>/dev/null)"' \
        || in_c 'du -sh /cache/uv 2>/dev/null | grep -qv "^0"'; then
      ok "the wheel cache is populated in the shared volume"
    else
      bad "/cache/uv looks empty after a real install"
    fi

    # The offline proof: a second, unrelated project reuses the warm cache.
    $BARDOLIER new pybits2 --archetype web >/dev/null || bad "second \`bardolier new\` failed"
    $BARDOLIER up pybits2 --no-shell >/dev/null 2>&1 || bad "bardolier up pybits2 failed"
    CONTAINER2="$($BARDOLIER status pybits2 --json 2>/dev/null | node -e "
      let s = ''
      process.stdin.on('data', (c) => (s += c)).on('end', () => {
        const d = JSON.parse(s)
        process.stdout.write(d.projects[0]?.dev_container ?? '')
      })
    ")"
    if [ -n "$CONTAINER2" ] && docker exec "$CONTAINER2" bash -lc \
        'cd /work && uv venv >/dev/null 2>&1 && uv pip install --python .venv --offline six >/dev/null 2>&1'; then
      ok "a second, unrelated project installs the same package --offline: the cache is shared"
    else
      bad "the second project could not install six --offline — the cache did not carry over"
    fi
    $BARDOLIER down pybits2 >/dev/null 2>&1 || true
    $BARDOLIER delete pybits2 --force >/dev/null 2>&1 || true
  fi
fi

$BARDOLIER down pybits >/dev/null 2>&1 || true

# ── Summary ───────────────────────────────────────────────────────────────────
summary "Images"
