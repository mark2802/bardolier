# claude-web — base image for the `web` and `library` archetypes (cli-spec.md §4.3).
#
# Built by `cproj build`, which passes HOST_UID/HOST_GID so that everything the
# container writes into the bind-mounted /work is owned by the Mac user. Without
# that, every file the agent creates would come back root-owned on the host.
#
# Deliberately toolchain-only: services (Postgres, Redis, …) are SHARED official
# images attached per project, never baked in here (CLAUDE.md, disk frugality).

ARG NODE_VERSION=22
FROM node:${NODE_VERSION}-bookworm-slim

# 501:20 is the macOS default (first user, `staff`) — the common case, and only
# a default: `cproj build` always passes the real values.
ARG HOST_UID=501
ARG HOST_GID=20
ARG USERNAME=dev

ENV DEBIAN_FRONTEND=noninteractive \
    LANG=C.UTF-8 \
    npm_config_fund=false \
    npm_config_audit=false

# The agent's working kit: git for history, ripgrep for search, curl/ca-certs for
# the network, tini so `docker exec`-spawned processes get reaped.
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

# Claude Code — the agent this whole yard exists to host.
#
# Installed as the pinned standalone binary rather than through npm, because two
# of the three base images have no Node and one mechanism for all three beats
# three. It lands in /usr/local/bin, NOT the installer's default
# `$HOME/.local/bin`: $HOME here is a per-project named volume (below), and
# anything the image leaves under $HOME is copied into it once per project.
#
# Pinned and checksum-verified against the publisher's manifest for that same
# version, exactly as swiftlint and the Android SDK are — a base image that
# builds a different toolchain tomorrow is not a base image.
ARG CLAUDE_CODE_VERSION=2.1.246
ARG TARGETARCH
RUN set -eux; \
    base="https://downloads.claude.ai/claude-code-releases"; \
    case "${TARGETARCH}" in \
      amd64) platform="linux-x64" ;; \
      arm64) platform="linux-arm64" ;; \
      *) echo "unsupported TARGETARCH: ${TARGETARCH}" >&2; exit 1 ;; \
    esac; \
    checksum="$(curl -fsSL "${base}/${CLAUDE_CODE_VERSION}/manifest.json" | jq -r ".platforms[\"${platform}\"].checksum")"; \
    case "${checksum}" in [0-9a-f][0-9a-f]*) ;; *) echo "no checksum for ${platform}" >&2; exit 1 ;; esac; \
    curl -fsSL -o /usr/local/bin/claude "${base}/${CLAUDE_CODE_VERSION}/${platform}/claude"; \
    echo "${checksum}  /usr/local/bin/claude" | sha256sum -c -; \
    chmod 0755 /usr/local/bin/claude; \
    CLAUDE_CONFIG_DIR=/tmp/claude-build claude --version; \
    rm -rf /tmp/claude-build

# `-o` (non-unique) matters: the node image already ships uid/gid 1000, and macOS
# gid 20 collides with Debian's `dialout`. Sharing an id is fine and is exactly
# what makes the bind mount line up; refusing to would break the whole point.
RUN set -eux; \
    if ! getent group "${HOST_GID}" >/dev/null; then groupadd -o -g "${HOST_GID}" "${USERNAME}"; fi; \
    if ! getent passwd "${HOST_UID}" >/dev/null; then \
      useradd -o -u "${HOST_UID}" -g "${HOST_GID}" -m -s /bin/bash "${USERNAME}"; \
    fi; \
    home="$(getent passwd "${HOST_UID}" | cut -d: -f6)"; \
    mkdir -p "${home}" /work; \
    chown -R "${HOST_UID}:${HOST_GID}" "${home}" /work

# Global npm installs go somewhere the unprivileged user owns, so `npm i -g`
# works in the container without sudo.
ENV NPM_CONFIG_PREFIX=/usr/local/npm-global
ENV PATH=${NPM_CONFIG_PREFIX}/bin:$PATH
RUN mkdir -p ${NPM_CONFIG_PREFIX} && chown -R "${HOST_UID}:${HOST_GID}" ${NPM_CONFIG_PREFIX}

# A PERSISTENT HOME, at a path the compose file can name.
#
# `cproj down` removes the container, so a home living in the container layer
# takes the shell history, the dotfiles and any `claude login` with it — the
# next `up` would start from nothing. So $HOME is a named volume, one per
# project (`cproj-<project>-home`, cli/src/images.ts CONTAINER_HOME).
#
# A FIXED path rather than the useradd-derived one, for the same reason
# /cache/gradle is: HOST_UID may collide with a user the base image already
# ships, which moves ~, and compose cannot mount a volume at a path it cannot
# predict. Claude Code's config dir then falls under it as $HOME/.claude, which
# is what makes `claude --continue` resume THIS project rather than whichever
# container last ran — every dev container has the same working dir, /work, so
# a shared config dir would file every project's sessions in one bucket.
#
# Owned by the host user in the image: Docker seeds a new named volume from the
# image directory, ownership included, and there is no sudo in here to fix it.
ENV HOME=/state/home
RUN mkdir -p /state/home && chown -R "${HOST_UID}:${HOST_GID}" /state

USER ${HOST_UID}:${HOST_GID}
WORKDIR /work

# The compose file overrides this with `sleep infinity` — the dev container is
# something to exec into, not a service. Kept here so the image is runnable alone.
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["sleep", "infinity"]
