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

USER ${HOST_UID}:${HOST_GID}
WORKDIR /work

# The compose file overrides this with `sleep infinity` — the dev container is
# something to exec into, not a service. Kept here so the image is runnable alone.
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["sleep", "infinity"]
