#!/usr/bin/env bash
# Phase 8 done-check — the mobile base images, for real, through the CLI: `new`
# and `up` an ios and an android project on a temp SSD, then work inside the
# container the generated compose file started.
#
#   IOS      swift build, swift test and swiftlint run; `xcodebuild` is absent,
#            because the boundary is a fact about the image and not only a
#            sentence in the seeded CLAUDE.md (which is checked too).
#   ANDROID  a real Gradle assembleDebug + unit test produces an APK on an
#            x86_64 container (Google ships aapt2 for x86_64 only, so the image
#            is pinned — cli/src/images.ts); its dependencies land in the SHARED
#            cache volume, which a second --offline build proves; `adb` is
#            absent for the same reason `xcodebuild` is.
#
# Files the container writes come back owned by the HOST user — the reason
# `cproj build` passes HOST_UID/HOST_GID. Needs a Docker daemon and the network;
# the first run builds both images (several GB, and the Android one compiles
# under emulation on Apple Silicon).
#
#   bash test/phase8-done-check.sh
#   PHASE8_QUICK=1 …      skip the in-container toolchain runs, keep the rest
#   PHASE8_NO_BUILD=1 …   never build an image; fail if one is missing
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO"

CPROJ="node cli/bin/cproj.js"
pass=0
fail=0
manual=0

ok()   { pass=$((pass + 1)); if [ -n "${VERBOSE:-}" ]; then printf '  \033[32m✓\033[0m %s\n' "$1"; fi; }
bad()  { printf '  \033[31m✗\033[0m %s\n' "$1"; fail=$((fail + 1)); }
skip() { printf '  \033[33m–\033[0m %s\n' "$1"; }
todo() { printf '  \033[33m⚠\033[0m %s\n' "$1"; manual=$((manual + 1)); }
section() { printf '\n\033[1m%s\033[0m\n' "$1"; }

TMP="$(cd "$(mktemp -d)" && pwd -P)"
VOLUME="$TMP/ssd"
MOUNTED="$VOLUME/claude-projects"
mkdir -p "$MOUNTED"

export CPROJ_CONFIG="$TMP/config.yml"
export CPROJ_SSD_VOLUME="$VOLUME"
export CPROJ_SSD_ROOT="$MOUNTED"

cleanup() {
  # Never leave containers behind: the projects are in a temp dir that is about
  # to vanish, and a running container holding it would be the mess this tool
  # exists to prevent.
  $CPROJ down-all --force >/dev/null 2>&1 || true
  # Every project now owns a $HOME volume (cli-spec.md §9). NOT the Gradle
  # cache: that is shared, expensive to refill, and the point of this phase.
  docker volume rm -f cproj-swiftbits-home cproj-droid-home >/dev/null 2>&1 || true
  rm -rf "$TMP"
}
trap cleanup EXIT

json_assert() { # json_assert <json> <js body over `d`>
  node -e "
    const d = JSON.parse(process.argv[1])
    process.exit((${2}) ? 0 : 1)
  " "$1" 2>/dev/null
}

# ── 1. The §4.3 map is complete ───────────────────────────────────────────────
section "1. Every archetype has a base image (§4.3)"

if node --input-type=module -e "
  import assert from 'node:assert/strict'
  import { baseImages } from './cli/src/images.ts'
  for (const image of baseImages()) {
    assert.ok(image.dockerfile, image.image + ' has no Dockerfile')
  }
" 2>/dev/null; then
  ok "claude-web, claude-ios and claude-and all have a Dockerfile on disk"
else
  bad 'a base image declared in §4.3 has no Dockerfile — build would report it unavailable'
fi

if npm test >/dev/null 2>&1; then ok "npm test — including test/phase8.test.ts"; else bad "npm test"; fi
if npm run typecheck >/dev/null 2>&1; then ok "npm run typecheck"; else bad "npm run typecheck"; fi

# ── 2. The images themselves ──────────────────────────────────────────────────
section "2. Base images"

if ! docker info >/dev/null 2>&1; then
  bad "the Docker daemon did not respond — this phase's check is about real containers"
  printf '\n\033[1mPhase 8: %d passed, %d failed\033[0m\n' "$pass" "$fail"
  exit 1
fi
ok "the Docker daemon responded"

have_image() { docker image inspect "$1:latest" >/dev/null 2>&1; }

for pair in "ios:claude-ios" "android:claude-and"; do
  archetype="${pair%%:*}"
  image="${pair##*:}"
  if have_image "$image"; then
    ok "$image:latest is present"
  elif [ "${PHASE8_NO_BUILD:-0}" = "1" ]; then
    bad "$image:latest is missing and PHASE8_NO_BUILD=1 — run \`cproj build --archetype $archetype\`"
  else
    printf '    building %s (this is the slow part; ^C is safe)\n' "$image"
    if $CPROJ build --archetype "$archetype" >"$TMP/build-$archetype.log" 2>&1; then
      ok "$image:latest built from cli/images/$image/Dockerfile"
    else
      bad "\`cproj build --archetype $archetype\` failed:"
      tail -5 "$TMP/build-$archetype.log" | sed 's/^/      /'
    fi
  fi
done

# The host identity is the whole reason `build` exists rather than `docker build`.
HOST_UID="$(id -u)"
HOST_GID="$(id -g)"
if BUILD="$($CPROJ build --archetype web --json 2>/dev/null)" \
  && json_assert "$BUILD" "d.uid === $HOST_UID && d.gid === $HOST_GID"; then
  ok "build passes this Mac's uid/gid ($HOST_UID:$HOST_GID) as build args"
else
  bad "build did not report the host identity"
fi

# ── 3. An ios project, from `new` to a test run ───────────────────────────────
section "3. ios — Swift toolchain, swiftlint, and no way to build the app (§4.3)"

$CPROJ new swiftbits --archetype ios >/dev/null || bad "\`cproj new --archetype ios\` failed"
IOS_DIR="$MOUNTED/swiftbits"

if [ -f "$IOS_DIR/docker-compose.yml" ] && grep -q "image: claude-ios:latest" "$IOS_DIR/docker-compose.yml"; then
  ok "the generated compose file starts the ios base image"
else
  bad "the ios project's compose file does not use claude-ios"
fi

CLAUDE_MD="$IOS_DIR/CLAUDE.md"
if grep -q "xcodebuild" "$CLAUDE_MD" && grep -qi "never run" "$CLAUDE_MD" && grep -q "swiftlint" "$CLAUDE_MD"; then
  ok "its seeded CLAUDE.md forbids xcodebuild/Simulator/signing and points at what does work here"
else
  bad "the ios CLAUDE.md does not steer the agent away from host-only build steps (§10)"
fi

if $CPROJ up swiftbits --no-shell >/dev/null 2>&1; then
  ok "cproj up swiftbits"
else
  bad "cproj up swiftbits failed"
fi

IOS_CONTAINER="$($CPROJ status swiftbits --json 2>/dev/null | node -e "
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

  if [ "${PHASE8_QUICK:-0}" = "1" ]; then
    skip "PHASE8_QUICK=1 — skipped swift build / swift test / swiftlint on a real package"
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
      OWNER="$(stat -f '%u' "$IOS_DIR/written-by-the-agent" 2>/dev/null || echo '?')"
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

$CPROJ down swiftbits >/dev/null 2>&1 || true

# ── 4. An android project, built and tested by Gradle ─────────────────────────
section "4. android — a real Gradle build and unit test in-container (§4.3)"

$CPROJ new droid --archetype android >/dev/null || bad "\`cproj new --archetype android\` failed"
AND_DIR="$MOUNTED/droid"

if grep -q "platform: linux/amd64" "$AND_DIR/docker-compose.yml"; then
  ok "the compose file pins the dev container to linux/amd64, as \`build\` built it (images.ts)"
else
  bad "the android compose file has no platform pin — aapt2 is x86_64-only, so the build would fail"
fi

if grep -q "cproj-gradle-cache:/cache/gradle" "$AND_DIR/docker-compose.yml" \
  && grep -q "external: true" "$AND_DIR/docker-compose.yml"; then
  ok "and mounts the shared Gradle cache as an external volume (§4.3, §9)"
else
  bad "the android compose file does not mount cproj-gradle-cache as an external volume"
fi

if grep -qi "emulator" "$AND_DIR/CLAUDE.md" && grep -q "adb" "$AND_DIR/CLAUDE.md"; then
  ok "its seeded CLAUDE.md keeps the emulator and adb on the host side (§10)"
else
  bad "the android CLAUDE.md does not name the host-side boundary"
fi

# A minimal but real Android application module: resources compiled by aapt2,
# an APK linked, and a JVM unit test — the three things the archetype promises.
mkdir -p "$AND_DIR/app/src/main" "$AND_DIR/app/src/test/java/com/example/droid"
cat > "$AND_DIR/settings.gradle" <<'GRADLE'
pluginManagement { repositories { google(); mavenCentral(); gradlePluginPortal() } }
dependencyResolutionManagement { repositories { google(); mavenCentral() } }
rootProject.name = 'droid'
include ':app'
GRADLE
cat > "$AND_DIR/app/build.gradle" <<'GRADLE'
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
cat > "$AND_DIR/app/src/main/AndroidManifest.xml" <<'XML'
<?xml version="1.0" encoding="utf-8"?>
<manifest xmlns:android="http://schemas.android.com/apk/res/android">
    <application android:label="droid" />
</manifest>
XML
cat > "$AND_DIR/app/src/test/java/com/example/droid/MathTest.java" <<'JAVA'
package com.example.droid;
import org.junit.Test;
import static org.junit.Assert.assertEquals;
public class MathTest {
    @Test public void adds() { assertEquals(4, 2 + 2); }
}
JAVA

if $CPROJ up droid --no-shell >/dev/null 2>&1; then
  ok "cproj up droid"
else
  bad "cproj up droid failed"
fi

# `up` creates the volume Compose was told is external — nobody else can, and
# without it `compose up` fails outright rather than silently.
if docker volume inspect cproj-gradle-cache >/dev/null 2>&1; then
  ok "cproj up created the shared cache volume"
  ROLE="$(docker volume inspect cproj-gradle-cache --format '{{index .Labels "cproj.role"}}' 2>/dev/null)"
  if [ "$ROLE" = "cache" ]; then
    ok "labelled cproj.role=cache, so the orphan scan knows it belongs to no project"
  else
    bad "the cache volume is labelled '$ROLE' — the volume scan would misattribute it"
  fi
else
  bad "cproj up did not create cproj-gradle-cache"
fi

AND_CONTAINER="$($CPROJ status droid --json 2>/dev/null | node -e "
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

  if [ "${PHASE8_QUICK:-0}" = "1" ]; then
    skip "PHASE8_QUICK=1 — skipped the Gradle build (the slow one: emulated, and it downloads AGP)"
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
    for candidate in "$AND_DIR"/app/build/outputs/apk/debug/*.apk; do
      [ -f "$candidate" ] && APK="$candidate" && break
    done
    if [ -n "$APK" ]; then
      ok "an APK is on the SSD, written through the bind mount: $(basename "$APK")"
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

$CPROJ down droid >/dev/null 2>&1 || true

# ── 5. Nothing in the repo attempts a host-only step ──────────────────────────
section "5. The boundary holds in the tooling too (CLAUDE.md)"

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

# ── 6. Earlier phases ─────────────────────────────────────────────────────────
section "6. Earlier phases"

# The ladder is walked ONCE, in order, by test/regression.sh (see its header).
# Recursing here — each check re-running all its predecessors, which did the
# same — made phase 0 come up dozens of times per invocation and turned this
# section into most of the run.
if [ -n "${CPROJ_REGRESSION:-}" ]; then
  ok "phases 0-7: already being walked, in order, by test/regression.sh"
else
  if bash test/regression.sh --through 7 >"$TMP/ladder.log" 2>&1; then
    ok "phases 0-7 still pass (test/regression.sh)"
  else
    bad "an earlier phase regressed — from test/regression.sh:"
    grep -m 6 '✗' "$TMP/ladder.log" | sed 's/^/      /'
  fi
fi

# ── Summary ───────────────────────────────────────────────────────────────────
printf '\n\033[1mPhase 8: %d passed, %d failed, %d manual\033[0m\n' "$pass" "$fail" "$manual"
[ "$fail" -eq 0 ] || exit 1

cat <<'MANUAL'

What is still the human's, on the Mac — the other side of the boundary:

  1. IOS, THE HOST HALF. Open the real app's .xcodeproj in Xcode, ⌘B, run it on
     a simulator, sign it. None of that is in the container and none of it ever
     will be; if a task seems to need it in there, the answer is this step.
  2. ANDROID, THE HOST HALF. Instrumented tests and the emulator. `cproj shell`
     into the project and run the unit tests; run the AVD from Android Studio.
  3. THE AGENT'S SIDE OF IT. Start an ios project, `cproj shell` into it, and
     ask the agent inside to build the app. It should read its CLAUDE.md, say
     the step is yours, and stop — rather than looking for a workaround.
MANUAL
printf '\033[32mDone-check passed.\033[0m\n'
