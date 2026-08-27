# cproj gaps found while migrating projects

Capabilities `docs/migration-guide.md` needed but cproj/the app don't have
yet. Each entry is a candidate for a future `docs/phases/N-slug.md`, not a
scoped plan itself — write one when there's enough real evidence (from
actual migrations) to know its shape. Entries are phrased generically; no
project is named here, matching the guide's own rule.

Route around a gap in the migration it was found in (the guide says how);
don't build a one-off fix for it in that project's own files.

---

## Open

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

**Why it doesn't work today:** `project.yml` has one `app_port` field,
assigned once by `new`/`up`; `status` and the app both assume one. The
generated `docker-compose.yml` publishes exactly one port (§9,
`ARCHETYPE_APP_PORT`) — hand-adding a second `ports:` entry is overwritten
by the next regeneration, which is deterministic by design.

**Shape a future phase would need to decide:** is this a second fixed
per-archetype port (like `ARCHETYPE_APP_PORT` but a pair), or a named,
per-project-declared port independent of archetype; how it's allocated
(own band, like services) and persisted; what `status`/`CprojModels.swift`
gain; whether `doctor`/eject/the volume scan need to know about it at all
(likely not — it's not a volume). Not designed yet.

**First seen:** while writing the migration guide, considering a project
that pairs a web frontend with native mobile clients.

---

### An interactive dev-tool port for `library` (and other portless) archetypes

**Need:** a `library`-archetype project wants a browser-reachable tool
running inside its dev container during interactive work — a
Jupyter/notebook server, a local dashboard, a debugger UI — not a frontend
dev server, just an interactive process a human wants to point a Mac browser
at while working.

**Why it doesn't work today:** `library` (like `ios`/`android`) publishes
nothing at all — there's no `app_port` field to reuse, and the `web`
archetype's single published port is specifically the frontend dev server,
not a general-purpose slot. This is a different shape from the second-port
gap above: that one is about a *second* port beside an archetype that
already has one; this is about archetypes that start with *zero*.

**Shape a future phase would need to decide:** whether this is an opt-in
port some archetypes can declare (and if so, on what basis it's
allocated/persisted — a per-project flag rather than anything
service-catalogue-shaped, since it's not a sibling container), or whether it
stays out of scope and such tools are expected to run without browser access
(CLI-driven / VS Code remote / etc.) in a container devbox. Not designed
yet.

**First seen:** while writing the migration guide, considering a project
shaped like pure research/analysis code that also pins a notebook server.

---

## Resolved

(none yet)
