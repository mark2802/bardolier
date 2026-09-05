# bardolier gaps found while migrating projects

Capabilities `docs/migration-guide.md` needed but bardolier/the app don't have
yet. Each entry is a candidate for a future `docs/phases/N-slug.md`, not a
scoped plan itself — write one when there's enough real evidence (from
actual migrations) to know its shape. Entries are phrased generically; no
project is named here, matching the guide's own rule.

Route around a gap in the migration it was found in (the guide says how);
don't build a one-off fix for it in that project's own files.

---

## Open

### Persisting user-space tooling installed inside the container

**Need:** a project whose dev container needs a tool that is neither an apt
package nor part of the base image's toolchain — an agent skill pack cloned
from a git repo and installed by its own `setup` script is the recurring
case, a hand-installed language runtime or CLI is another. The tool writes
under `$HOME`, self-updates, and keeps mutable config and state there; it is
a per-project (or per-user) choice, not something every project on the base
image should carry.

**Why it doesn't work today:** the three mechanisms that persist something
each answer a different question, and none of them answers this one.
`extra_packages` (§6 Deps) is apt-only — one `apt-get install` line in an
image that is content-addressed and shared by every project declaring the
same set, so it cannot hold a `git clone` plus an install script, and should
not hold a per-user preference. The base images hold toolchains, pinned and
checksum-verified, which is right for a runtime every project on that image
needs and wrong for one project's choice; and because `$HOME` is a mounted
volume, anything installed there at image-build time is masked at runtime
anyway. That leaves the per-project `$HOME` volume, which is where such a
tool lands by default: it survives `down`/`up` as intended, but it is
destroyed by `delete --purge` and by a `docker` prune of unused volumes, and
**nothing anywhere records how to rebuild it**. The install is a sequence of
commands typed into a shell once; after a prune, the only trace left is
whatever the tool appended to files under `/work` — which survives and now
refers to something that is gone.

**Shape a future phase would need to decide:** whether the answer is a
durable *path* (a second bind mount from inside the project directory, e.g.
`./.bardolier/packages:/packages`, always mounted like `$HOME`, with the
directory on the SSD so no Docker operation can take it — plus a
`PACKAGES_DIR` constant and `ENV PATH=…` in the base images, since compose
cannot extend `PATH` without substituting the host's); or a re-runnable
*recipe* (a manifest-declared provision script in the project directory that
`up` runs inside the container behind a marker guard, mirroring the way
`down` already runs the agent through `docker exec` for the handoff note);
or both. The path makes the install survive; the recipe makes it
reproducible on a new machine or a new project. Which one leads depends on
which shape recurs — a second tool of the same kind argues for the path, an
install that must be re-run against a moving upstream argues for the recipe.
Also open: whether a re-downloadable browser/asset cache such tools pull down
belongs here at all, or in a shared named volume under the `IMAGE_CACHE`
pattern (disk frugality says the latter; prune-immunity says the former).

**Routed around today by:** installing the tool under the project directory
rather than `$HOME` — see the "installed by its own installer script" bullet
in Part 3 of `docs/migration-guide.md`. That route-around leaves a re-link
script in the project's own files, which is precisely the cost of not having
the capability.

**First seen:** re-running a project whose container-local agent tooling had
been installed by hand; a Docker cleanup removed the per-project `$HOME`
volume, and the routing block the installer had appended to the project's
own `CLAUDE.md` — which lives under `/work` and survived — was left pointing
at commands that no longer existed.

---

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
published in compose alongside `app_port`. `bardolier port add <project> <name>
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
archetype-independent, so `bardolier port add` works identically on `library`,
`ios` and `android` as on `web`; there is no separate "opt-in per archetype"
flag, because nothing about the port depends on what the archetype serves.
