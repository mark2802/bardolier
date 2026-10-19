# bardolier-ios — base image for the `ios` archetype (cli-spec.md §4.3).
#
# EDIT + SWIFTLINT + LOGIC TESTS, and nothing else. Xcode, the Simulator, and
# code signing are macOS-host-only (CLAUDE.md's boundary); the seeded project
# CLAUDE.md tells the agent inside so, and there is deliberately nothing here it
# could mistake for a way around it — no `xcodebuild`, no simulator runtime.
#
# What IS here is the open-source Swift toolchain on Linux: `swift build`,
# `swift test`, and `swiftlint`. That covers a package's logic tests and every
# lint the human would otherwise only see in Xcode.
#
# Built by `bardolier build`, which passes HOST_UID/HOST_GID so that everything the
# container writes into the bind-mounted /work is owned by the Mac user.

ARG SWIFT_VERSION=6.3
FROM swift:${SWIFT_VERSION}-noble

# 501:20 is the macOS default (first user, `staff`) — the common case, and only
# a default: `bardolier build` always passes the real values.
ARG HOST_UID=501
ARG HOST_GID=20
ARG USERNAME=dev

ENV DEBIAN_FRONTEND=noninteractive \
    LANG=C.UTF-8

# The same working kit as bardolier-web: git for history, ripgrep for search,
# curl/ca-certs for the network, tini so `docker exec`-spawned processes get
# reaped. The Swift toolchain's own build dependencies are already in the base.
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
      zsh \
    && rm -rf /var/lib/apt/lists/*

# zsh with oh-my-zsh as the interactive shell (`bardolier shell` prefers it, falls
# back to bash). Installed under /usr/local/share, NOT $HOME: $HOME is a bind mount
# that masks anything the image put there. Pinned to a commit and checksum-verified,
# like uv. The config is global (/etc/zsh/zshrc) so a project's own ~/.zshrc still
# runs after it and can override. No auto-update (the install dir is root-owned and
# the prompt gets in the way); the cache and history live under $HOME, so they
# survive `down`. /etc/zsh/zshenv creates an empty ~/.zshrc so a fresh home does
# not trigger zsh-newuser-install's first-run menu.
ARG OHMYZSH_COMMIT=964ddf789b022b6958b27d02d7fa54f552de21e9
ARG OHMYZSH_SHA256=89ccb57b3328f0df303d557bef54cc7d0efb6f22f016552943ef3e15273e0588
RUN set -eux; \
    tmp="$(mktemp -d)"; \
    curl -fsSL -o "${tmp}/omz.tgz" "https://github.com/ohmyzsh/ohmyzsh/archive/${OHMYZSH_COMMIT}.tar.gz"; \
    echo "${OHMYZSH_SHA256}  ${tmp}/omz.tgz" | sha256sum -c -; \
    mkdir -p /usr/local/share/oh-my-zsh; \
    tar -xzf "${tmp}/omz.tgz" -C /usr/local/share/oh-my-zsh --strip-components=1; \
    chmod -R go-w /usr/local/share/oh-my-zsh; \
    rm -rf "${tmp}"; \
    { \
      echo 'export ZSH=/usr/local/share/oh-my-zsh'; \
      echo 'ZSH_THEME=robbyrussell'; \
      echo 'plugins=(git)'; \
      echo 'DISABLE_AUTO_UPDATE=true'; \
      echo 'ZSH_CACHE_DIR=$HOME/.cache/oh-my-zsh'; \
      echo 'ZSH_COMPDUMP=$ZSH_CACHE_DIR/.zcompdump'; \
      echo 'mkdir -p "$ZSH_CACHE_DIR/completions"'; \
      echo 'HISTFILE=$HOME/.zsh_history; HISTSIZE=10000; SAVEHIST=10000'; \
      echo 'source $ZSH/oh-my-zsh.sh'; \
    } > /etc/zsh/zshrc; \
    { \
      echo 'if [[ $- == *i* && ! -e "$HOME/.zshrc" ]]; then : > "$HOME/.zshrc"; fi'; \
    } > /etc/zsh/zshenv

# Claude Code — the agent this whole yard exists to host.
#
# The standalone binary, not the npm package: there is no Node in this image and
# adding a whole runtime to carry one tool would be the wrong trade. It lands in
# /usr/local/bin rather than the installer's default `$HOME/.local/bin`, because
# $HOME here is a per-project named volume (below) and anything the image leaves
# under $HOME is copied into it once per project.
#
# Checksum-verified like swiftlint below, but NOT pinned by default: `bardolier
# build` defaults CLAUDE_CODE_VERSION to `latest`, resolved at build time.
# `--claude-code-version <X.Y.Z>` pins an exact release when needed
# (cli/images/bardolier-web/Dockerfile has the full case for why).
ARG CLAUDE_CODE_VERSION=2.1.247
ARG TARGETARCH
RUN set -eux; \
    base="https://downloads.claude.ai/claude-code-releases"; \
    case "${TARGETARCH}" in \
      amd64) platform="linux-x64" ;; \
      arm64) platform="linux-arm64" ;; \
      *) echo "unsupported TARGETARCH: ${TARGETARCH}" >&2; exit 1 ;; \
    esac; \
    version="${CLAUDE_CODE_VERSION}"; \
    if [ "${version}" = "latest" ]; then version="$(curl -fsSL "${base}/latest")"; fi; \
    checksum="$(curl -fsSL "${base}/${version}/manifest.json" | jq -r ".platforms[\"${platform}\"].checksum")"; \
    case "${checksum}" in [0-9a-f][0-9a-f]*) ;; *) echo "no checksum for ${platform} at ${version}" >&2; exit 1 ;; esac; \
    curl -fsSL -o /usr/local/bin/claude "${base}/${version}/${platform}/claude"; \
    echo "${checksum}  /usr/local/bin/claude" | sha256sum -c -; \
    chmod 0755 /usr/local/bin/claude; \
    CLAUDE_CONFIG_DIR=/tmp/claude-build claude --version; \
    rm -rf /tmp/claude-build

# SwiftLint ships prebuilt Linux binaries per architecture, so this is a
# download rather than the ~10-minute SwiftSyntax compile a source build costs.
# TARGETARCH is BuildKit's (amd64 | arm64) and matches the asset names.
#
# The zip carries two binaries and the DYNAMIC one is installed on purpose: the
# static build refuses SourceKit, which silently disables every rule that needs
# type information ("Skipping enabled rule … SourceKit access is prohibited").
# A lint that quietly checks less than it says it does is worse than no lint.
# The cost is a coupling to SWIFT_VERSION's runtime — so `swiftlint version`
# runs here, in the build, where a mismatch fails loudly instead of in a shell
# three weeks later.
ARG SWIFTLINT_VERSION=0.65.1
ARG TARGETARCH
RUN set -eux; \
    url="https://github.com/realm/SwiftLint/releases/download/${SWIFTLINT_VERSION}/swiftlint_linux_${TARGETARCH}.zip"; \
    tmp="$(mktemp -d)"; \
    curl -fsSL -o "${tmp}/swiftlint.zip" "$url"; \
    unzip -q "${tmp}/swiftlint.zip" -d "${tmp}"; \
    install -m 0755 "${tmp}/swiftlint" /usr/local/bin/swiftlint; \
    rm -rf "${tmp}"; \
    swiftlint version

# `-o` (non-unique) matters: macOS gid 20 collides with Debian/Ubuntu's
# `dialout`, and sharing an id is exactly what makes the bind mount line up.
RUN set -eux; \
    if ! getent group "${HOST_GID}" >/dev/null; then groupadd -o -g "${HOST_GID}" "${USERNAME}"; fi; \
    if ! getent passwd "${HOST_UID}" >/dev/null; then \
      useradd -o -u "${HOST_UID}" -g "${HOST_GID}" -m -s /bin/zsh "${USERNAME}"; \
    fi; \
    home="$(getent passwd "${HOST_UID}" | cut -d: -f6)"; \
    mkdir -p "${home}" /work; \
    chown -R "${HOST_UID}:${HOST_GID}" "${home}" /work

# A PERSISTENT HOME, at a path the compose file can name (cli/src/images.ts,
# CONTAINER_HOME). `bardolier down` removes the container, so a home in the
# container layer takes the shell history, the dotfiles and any `claude login`
# with it. A fixed path rather than the useradd-derived one because HOST_UID may
# collide with a user the base image already ships, which moves ~ — and compose
# cannot mount a volume at a path it cannot predict.
#
# Claude Code's config dir falls under it as $HOME/.claude, per project, which
# is what makes `claude --continue` resume THIS project: every dev container has
# the same working dir, /work, so one shared config dir would file every
# project's sessions in a single bucket.
#
# Owned by the host user in the image: Docker seeds a new named volume from the
# image directory, ownership included, and there is no sudo in here.
ENV HOME=/state/home
# The passwd entry moves too: ssh expands `~` from getpwuid, not $HOME, so a
# key left at $HOME/.ssh is invisible to it while pw_dir is the useradd default.
RUN mkdir -p /state/home && chown -R "${HOST_UID}:${HOST_GID}" /state \
 && usermod -d /state/home "$(getent passwd "${HOST_UID}" | cut -d: -f1)"

USER ${HOST_UID}:${HOST_GID}
WORKDIR /work

# The compose file overrides this with `sleep infinity` — the dev container is
# something to exec into, not a service. Kept here so the image is runnable alone.
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["sleep", "infinity"]
