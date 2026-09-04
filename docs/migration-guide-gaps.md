# bandolier gaps found while migrating projects

Capabilities `docs/migration-guide.md` needed but bandolier/the app don't have
yet. Each entry is a candidate for a future `docs/phases/N-slug.md`, not a
scoped plan itself — write one when there's enough real evidence (from
actual migrations) to know its shape. Entries are phrased generically; no
project is named here, matching the guide's own rule.

Route around a gap in the migration it was found in (the guide says how);
don't build a one-off fix for it in that project's own files.

---

## Open

(none currently)

## Resolved

### A second, host-published port per project

**Need:** a project whose backend must be reached directly by something
other than its own web frontend — a native mobile client running in the
Simulator/emulator during dev is the recurring case, a third-party webhook
sender is another. The `web` archetype's frontend can proxy to an internal
backend (Part 2, option A of the guide) when only the browser needs to reach
it, but a mobile client has no such intermediary to go through.

The same limit shows up even when every consumer is a browser: a project
with more than one of its own independently-served frontend/UI apps (a
public site plus a separate staff/admin app, an internal tooling dashboard,
...) needs each one reachable directly, and only the first can hold the
archetype's single `app_port`.

**Why it didn't work before:** `project.yml` had one `app_port` field,
assigned once by `new`/`up`; `status` and the app both assumed one. The
generated `docker-compose.yml` published exactly one port (§9,
`ARCHETYPE_APP_PORT`) — hand-adding a second `ports:` entry was overwritten
by the next regeneration, which is deterministic by design.

**First seen:** while writing the migration guide, considering a project
that pairs a web frontend with native mobile clients.

**Resolved by:** Phase 12 (`docs/phases/12-extra-ports.md`) — `extra_ports`
in `project.yml`, a named, per-project port independent of archetype,
published in compose alongside `app_port`. `bandolier port add <project> <name>
--container-port <n>` declares one; the allocator starts at the given
container port (no catalogue band to inherit) and persists the pair, exactly
like `app_port`. See `cli-spec.md` §5.1 and Part 2 of the migration guide.

---

### An interactive dev-tool port for `library` (and other portless) archetypes

**Need:** a `library`-archetype project wants a browser-reachable tool
running inside its dev container during interactive work — a
Jupyter/notebook server, a local dashboard, a debugger UI — not a frontend
dev server, just an interactive process a human wants to point a Mac browser
at while working.

**Why it didn't work before:** `library` (like `ios`/`android`) published
nothing at all — there was no `app_port` field to reuse, and the `web`
archetype's single published port was specifically the frontend dev server,
not a general-purpose slot. This is a different shape from the second-port
gap above: that one is about a *second* port beside an archetype that
already has one; this is about archetypes that start with *zero*.

**First seen:** while writing the migration guide, considering a project
shaped like pure research/analysis code that also pins a notebook server.

**Resolved by:** the same mechanism as the entry above — `extra_ports` is
archetype-independent, so `bandolier port add` works identically on `library`,
`ios` and `android` as on `web`; there is no separate "opt-in per archetype"
flag, because nothing about the port depends on what the archetype serves.
