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

## Resolved

(none yet)
