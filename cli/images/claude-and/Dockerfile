# claude-and — base image for the `android` archetype (cli-spec.md §4.3).
#
# GRADLE BUILDS AND UNIT TESTS RUN HERE. The emulator does not: an AVD needs
# host virtualisation and a display, so instrumented tests are the human's job
# on the Mac (CLAUDE.md's boundary, and the seeded project CLAUDE.md says so to
# the agent inside). `adb` is deliberately NOT installed — see platform-tools
# below — so the boundary is a fact about the image, not just advice.
#
# Built by `cproj build`, which passes HOST_UID/HOST_GID so that everything the
# container writes into the bind-mounted /work is owned by the Mac user.
#
# ARCHITECTURE: this image is pinned to linux/amd64 by `cproj build` and by the
# generated compose file (cli/src/images.ts). Google publishes the Linux SDK
# build tools — aapt2 above all — for x86_64 ONLY; there is no linux-aarch64
# aapt2 in the SDK or on maven.google.com. On Apple Silicon Docker therefore
# runs this one image emulated, which is slower but actually works; a native
# arm64 image would fail at the first resource-compilation step of any app
# module. Do not "fix" the pin without checking that aapt2 ships for arm64.

ARG JAVA_VERSION=21
FROM eclipse-temurin:${JAVA_VERSION}-jdk-noble

# 501:20 is the macOS default (first user, `staff`) — the common case, and only
# a default: `cproj build` always passes the real values.
ARG HOST_UID=501
ARG HOST_GID=20
ARG USERNAME=dev

ENV DEBIAN_FRONTEND=noninteractive \
    LANG=C.UTF-8

# The same working kit as claude-web, plus the archive tools the SDK needs.
RUN apt-get update && apt-get install -y --no-install-recommends \
      ca-certificates \
      curl \
      git \
      jq \
      less \
      openssh-client \
      procps \
      ripgrep \
      tini \
      unzip \
      zip \
    && rm -rf /var/lib/apt/lists/*

ENV ANDROID_HOME=/opt/android-sdk \
    ANDROID_SDK_ROOT=/opt/android-sdk \
    GRADLE_HOME=/opt/gradle

# The command-line tools, pinned by build number rather than `_latest` alone, so
# the same Dockerfile builds the same SDK tomorrow.
ARG ANDROID_CMDLINE_TOOLS=16111833
RUN set -eux; \
    tmp="$(mktemp -d)"; \
    curl -fsSL -o "${tmp}/tools.zip" \
      "https://dl.google.com/android/repository/commandlinetools-linux-${ANDROID_CMDLINE_TOOLS}_latest.zip"; \
    mkdir -p "${ANDROID_HOME}/cmdline-tools"; \
    unzip -q "${tmp}/tools.zip" -d "${ANDROID_HOME}/cmdline-tools"; \
    mv "${ANDROID_HOME}/cmdline-tools/cmdline-tools" "${ANDROID_HOME}/cmdline-tools/latest"; \
    rm -rf "${tmp}"

ENV PATH=${ANDROID_HOME}/cmdline-tools/latest/bin:${GRADLE_HOME}/bin:$PATH

# platform-tools is NOT installed: it exists to talk to a device or emulator,
# both of which are host-side. Leaving it out keeps the image smaller and keeps
# `adb` from being something the agent in here can reach for.
ARG ANDROID_PLATFORM=android-36
ARG ANDROID_BUILD_TOOLS=36.0.0
RUN set -eux; \
    yes | sdkmanager --licenses >/dev/null; \
    sdkmanager --install "platforms;${ANDROID_PLATFORM}" "build-tools;${ANDROID_BUILD_TOOLS}" >/dev/null; \
    sdkmanager --list_installed

# A Gradle on PATH for projects without a wrapper. A project WITH a wrapper uses
# its own distribution, as it should — the wrapper's version is the project's
# business, not the image's.
ARG GRADLE_VERSION=9.7.1
RUN set -eux; \
    tmp="$(mktemp -d)"; \
    curl -fsSL -o "${tmp}/gradle.zip" "https://services.gradle.org/distributions/gradle-${GRADLE_VERSION}-bin.zip"; \
    unzip -q "${tmp}/gradle.zip" -d /opt; \
    mv "/opt/gradle-${GRADLE_VERSION}" "${GRADLE_HOME}"; \
    rm -rf "${tmp}"

# `-o` (non-unique) matters: macOS gid 20 collides with Debian/Ubuntu's
# `dialout`, and sharing an id is exactly what makes the bind mount line up.
#
# The SDK is chowned to the host user because Gradle installs missing packages
# into it (a project targeting another API level does this on first build);
# root-owned it would fail, and there is no sudo in here.
RUN set -eux; \
    if ! getent group "${HOST_GID}" >/dev/null; then groupadd -o -g "${HOST_GID}" "${USERNAME}"; fi; \
    if ! getent passwd "${HOST_UID}" >/dev/null; then \
      useradd -o -u "${HOST_UID}" -g "${HOST_GID}" -m -s /bin/bash "${USERNAME}"; \
    fi; \
    home="$(getent passwd "${HOST_UID}" | cut -d: -f6)"; \
    mkdir -p "${home}" /work /cache/gradle; \
    chown -R "${HOST_UID}:${HOST_GID}" "${home}" /work /cache "${ANDROID_HOME}"

# Gradle's caches are large, rebuildable, and identical across projects — the
# Android Gradle Plugin and its transitive world are hundreds of megabytes that
# every project would otherwise download for itself, onto the SSD, which is the
# scarce disk. So /cache/gradle is a NAMED VOLUME shared by every claude-and
# container (cli/src/images.ts, IMAGE_CACHE): `cproj up` creates it, the
# generated compose file mounts it, and nothing about it is the project's.
#
# It must exist in the image, owned by the host user: Docker seeds a new named
# volume from the image's directory, ownership included, and there is no sudo in
# here to fix it afterwards.
#
# NOT under /work: a path in the bind mount is a per-project copy on the SSD,
# and a path under $HOME cannot be named up front — HOST_UID may collide with a
# user the base image already has, which moves ~.
ENV GRADLE_USER_HOME=/cache/gradle

USER ${HOST_UID}:${HOST_GID}
WORKDIR /work

# The compose file overrides this with `sleep infinity` — the dev container is
# something to exec into, not a service. Kept here so the image is runnable alone.
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["sleep", "infinity"]
