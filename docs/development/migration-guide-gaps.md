# bardolier gaps found while migrating projects

Capabilities `docs/migration-guide.md` needed but bardolier/the app don't have
yet. Each entry is a candidate for a future `docs/development/phases/N-slug.md`, not a
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

**Why it doesn't work today** (narrowed by phase 19): the mechanisms that
persist something each answer a different question. `extra_packages` (§6
Deps) is apt-only — one `apt-get install` line in an image that is
content-addressed and shared by every project declaring the same set, so it
cannot hold a `git clone` plus an install script, and should not hold a
per-user preference. The base images hold toolchains, pinned and
checksum-verified, which is right for a runtime every project on that image
needs and wrong for one project's choice; and because `$HOME` is a mounted
directory, anything installed there at image-build time is masked at runtime
anyway.

Phase 19 answered the **durability** half of this gap and no more. `$HOME` is
now the project's own `home/` directory (`cli-spec.md` §3), on the same disk
as the project: an install there survives `down`, survives any `docker`
prune, and a plain `delete` refuses (`PROJECT_HAS_DATA`) rather than taking
it. What remains is that **nothing records how to rebuild it**. The install is
a sequence of commands typed into a shell once; a second machine, a
re-created project, or `delete --purge` starts from nothing, and the only
trace is whatever the tool appended to files under `/work` — which is
committed, and points at something that isn't there. `$HOME` being
per-project (deliberately: Claude Code files sessions by working directory)
makes that recurring rather than one-off — every project wanting the tool
installs it again by hand.

**Shape a future phase would need to decide:** with the durable path now part
of the layout, what is left is a re-runnable *recipe* — a manifest-declared
provision script in the project directory that `up` runs inside the container
behind a marker guard, mirroring the way `down` already runs the agent
through `docker exec` for the handoff note. Open within that: what makes it
re-run (a marker in `home/`, a hash of the script, an explicit command); and
how it fails, since a provisioning step that breaks `up` would be worse than
the hand install it replaces — best-effort with a warning, like the handoff
note, is the likely answer. Two smaller ones ride along. `PATH` still cannot
come from compose (`${PATH}` there substitutes the Mac's value), so a
provisioned tool's bin directory needs somewhere to be declared. And a
re-downloadable browser/asset cache such tools pull down probably belongs in
a shared named volume under the `IMAGE_CACHE` pattern rather than once per
project — disk frugality, and it is not project data.

**Routed around today by:** letting the installer put the tool where it wants
it (`$HOME`, i.e. the project's `home/`) and leaving a short script in
`local/` recording what was run — see the "installed by its own installer
script" bullet in Part 3 of `docs/migration-guide.md`. That script, written
by hand and re-run by hand per project, is precisely the cost of not having
the capability.

**First seen:** re-running a project whose container-local agent tooling had
been installed by hand; a Docker cleanup removed the per-project `$HOME`
volume, and the routing block the installer had appended to the project's
own `CLAUDE.md` — which lived under `/work` and survived — was left pointing
at commands that no longer existed. Phase 19 removed that particular failure
mode: the volume is a directory in the project now. It did not remove the
part that hurt, which was reconstructing the install from memory.

---

### Pinning a per-project Node version

**Need:** a `web`-archetype project whose repo pins an exact Node version
(`.nvmrc` or equivalent) that differs from the base image's.

**Why it doesn't work today:** `bardolier-web` sets Node from a
`NODE_VERSION` build arg on an image shared by every `web` project, and ships
no version manager — unlike Python, where `uv` reads `.python-version`
itself and installs whatever it names into the shared cache. There is no
per-project hook to change it.

**Shape a future phase would need to decide:** `deps.ts` already builds a
content-addressed derived image per declared package set (§6 Deps), which is
the likely mechanism for a `node_version` field to reuse. Open within that:
whether a second Node in a derived layer is worth the image size, or whether
a version manager (`fnm`, `n`) belongs in the base image instead, with the
pin read from the project the same way `uv` reads `.python-version`.

**Routed around today by:** running on the base image's Node and updating
the repo's own pin to match, when the gap between the two is minor enough
not to matter (checked against the project's actual dependencies first). In
the one migration that hit this, a two-major-version gap (20 → 22) ran the
project's existing dependency set with no observed issue — the gap here is
about reproducibility and the pin silently going stale, not a version that
has actually broken anything yet.

**First seen:** migrating a Next.js project pinning Node 20 against a base
image shipping Node 22.

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

**Resolved by:** Phase 12 (`docs/development/phases/12-extra-ports.md`) — `extra_ports`
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
