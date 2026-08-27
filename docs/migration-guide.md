# Migrating an existing project onto cproj

**Audience:** whoever (human or agent) is doing the migration. Written as a
runbook to execute, not background reading — follow it in order. Steps marked
**STOP** need a decision from the project's owner before continuing; don't
guess past them.

**Not a phase spec.** This changes no CLI behaviour, so it carries no schema
and no done-check. When a step below turns out to need one — the project
needs something cproj cannot do yet — write that down in
`docs/migration-guide-gaps.md` (last section) and route around it for now.
Don't hand-invent the capability per project; a generated file a hand-edit
"fixes" today is overwritten the next `up` (`docker-compose.yml` is generated,
never patched — CLAUDE.md, "Generated vs seeded").

This guide assumes the project is a **web** archetype migration (a frontend,
maybe a backend API, maybe backing services) — by far the common case. Where
something is `ios`/`android`-specific it says so.

---

## Part 1 — The steps that apply to nearly every migration

### 1. Survey the source project

Before touching anything, read (don't yet act on):
- Every `docker-compose*.yml` / `Dockerfile` in the repo — what services, what
  images/versions, what env vars, what volumes.
- Every `.env` / `.env.example` — connection strings, secrets, what a
  `localhost`-shaped value implies about how the pieces currently talk to
  each other.
- Frontend package manifest — dev script, framework (Next/Vite/CRA/...), and
  whether it calls a backend directly or through its own dev server.
- Backend manifest (`requirements.txt`/`pyproject.toml`/`package.json`/...) —
  language, pinned runtime version, any background-worker process.
- Root-level dotfiles that will collide with what `cproj new` seeds:
  `.gitignore`, `.dockerignore`, `CLAUDE.md` (see step 5).
- Whether there's a `.git` at all, and if so `git remote -v` and current
  branch, and whether anything local is uncommitted or unpushed — this is
  exactly what decides which of step 4's three cases applies.

### 2. Decide the archetype and the service mapping

- Archetype is `web` unless the project is actually a native mobile client
  with no web/API half (then see the `ios`/`android` phases instead — this
  guide doesn't cover that side).
- For each backing service in the old compose file, decide:
  - **It's postgres/redis/mongo and an official image** → use the catalogue
    entry as-is. Don't pin a project-specific version unless step-9-style
    testing shows an actual incompatibility (see Part 3, "catalogue version
    mismatch").
  - **It's some other official, pullable image** (queue, search, object
    store, mail-catcher, ...) → add a `services.yml` entry for it (same
    shape as the existing ones: `image`, `container_port`, `host_port_base`,
    `volume`, `mount`, optional `env`). This is additive and shared across
    every project, not a one-off.
  - **It's the project's own code** (an API, a worker) → it is never a
    catalogue service. It runs as a process inside the one dev container,
    same as the frontend. See step 8.

### 3. Create the project

```
cproj new <name> --archetype web --services <postgres,redis,...>
```

This assigns ports and writes `project.yml`, a generated `docker-compose.yml`,
and seeded `.gitignore` / `.dockerignore` / `CLAUDE.md`. Do this **before**
moving the real source in — `new` refuses (`PROJECT_EXISTS`) if the directory
already has anything in it, and it's the only thing that assigns ports.

### 4. Get the source in — move, clone, or copy, depending what it is

However it arrives, exclude anything regenerable that shouldn't cost SSD
space: `node_modules`, `.venv`, `__pycache__`, build output (`.next`, `dist`,
`build`), `.DS_Store`, tool caches (`.mypy_cache`, `.pytest_cache`). These are
already excluded by the project's own `.gitignore` in most cases — check.
Which of the three below applies is exactly what step 1's `git remote -v`
check was for.

- **A git repo with a remote you trust as the source of truth.** Default to
  **moving** the existing local working tree (not cloning fresh) — it's
  strictly safer, since it carries over anything not yet pushed (local
  commits, branches, stashes) that a clone would silently drop. **STOP:**
  clone fresh from the remote instead only when you've confirmed there's
  nothing local worth keeping and you specifically want a guaranteed-clean
  tree (e.g. known-stray local modifications you don't want along for the
  ride) — that's a real, different outcome, so it's a conscious choice, not
  a default.
- **A git repo with no remote (or one that isn't going to keep being used).**
  Move the working tree, `.git` included, so history travels. Don't `git
  clone` a local path for this — it creates a new repo whose `origin` points
  at the old local path, which is about to stop existing.
- **No git at all.** There's nothing to move but the files — copy or move
  them in directly. **STOP:** decide now whether to `git init` a fresh
  repository at this point (recommended, so this project gets the same
  history-going-forward that every other cproj project has) or leave it
  untracked; either is fine, but it's the project owner's call, not a
  default this guide should make for you.

### 5. Reconcile files that exist on both sides — merge, don't clobber

`cproj new` just seeded three files the old project may already have:

- **`.gitignore`** — keep the project's own (it's more complete for that
  project); just add cproj's one addition, `.cproj/` (the handoff note,
  regenerated on every stop — churn, not history).
- **`.dockerignore`** — keep cproj's seeded one unless the project had its
  own at the root (rare, since most only had one per Dockerfile's own
  directory).
- **`CLAUDE.md`** — genuinely merge. Keep the project's own dev-workflow
  content (test commands, conventions, architecture notes) and append
  cproj's seeded sections (environment boundary, dev-server/proxy note,
  services, "managing this project"). One file, both halves.

**Check for a case-only collision before you do any of this.** On the
default (case-insensitive) macOS/APFS filesystem, `claude.md` and
`CLAUDE.md` are **the same file** — writing one after the other silently
overwrites it, no error, no warning. Test it if unsure:
`touch a.md A.MD && ls` — one file means the filesystem folded them. If the
project has its own lowercase `claude.md` (or any other seeded filename in a
different case), that's exactly this collision — merge deliberately per
above rather than letting a plain copy decide the winner by accident.

### 6. Point the environment at service names, not `localhost`

Every connection string that used to read `localhost:5432` /
`localhost:6379` / etc. now reads the service name from the catalogue
(`postgres`, `redis`, ...) — they're sibling containers on the project's own
Docker network. Reconcile any database/user names the project's code expects
against what the catalogue actually provisions (it interpolates
`{project}` for the database name, and won't set a user unless you told it
to) — update the project's env, don't fight the catalogue.

### 7. Pin the toolchain version(s) to what the project already committed to

If the old Dockerfile (or CI config) pinned an exact language version, pin
the same version in the new container so behaviour doesn't drift: a
`.python-version` file for `uv`, an `.nvmrc`-equivalent for Node. This is
free — it's not a new capability, just carrying an existing decision over.
Check the file's content actually resolves as a plain interpreter version
before copying it verbatim — some version-manager files instead name a
pyenv-virtualenv (or similar) alias, which `uv`/an `.nvmrc`-equivalent can't
resolve. If so, find the real underlying version wherever it's actually
recorded (`pyenv versions`, the project's CI config, a lockfile) and pin that
instead.

### 8. Decide how a second app process is reached

If the project is frontend-only and has only one frontend app, skip this
step. If it has its own backend process (API, worker, ...), **or more than
one of its own frontend/UI apps** (a public site plus a separate staff/admin
app, an internal tooling UI, ...), read **Part 2** now and make the call
before `up`.

### 9. Bring it up and verify

```
cproj up <name>
```
Shell in (or let the app), install dependencies for whatever runs in the
container (`uv sync` / `npm install`, per process), start each process by
hand — this container is a devbox to exec into, nothing supervises processes
for you. Then verify from the **Mac**, not from inside the container:
`cproj status <name>` for the URL, load it in a browser, confirm a page that
hits the backend actually gets data, confirm the backend can reach its
services by name.

### 10. Note anything the project needed that cproj couldn't do

If step 8, or anything else, needed a capability cproj doesn't have — don't
build a per-project workaround for it. Add it to
`docs/migration-guide-gaps.md` and route around it in this migration (see
Part 2 for the specific case of a second published port).

---

## Part 2 — The port-policy decision

cproj's `web` archetype publishes **exactly one port** — the frontend's dev
server. That's a real constraint, not an oversight: `project.yml` has one
`app_port` field, assigned once, and `status`/the app both assume there's one
to report. A project with its own backend process wants that process
reachable by *something* — the question is by what, and there are two shapes:

**A — Proxy through the one published port.** The frontend dev server
(Next.js `rewrites()`, Vite's `server.proxy`, CRA's `package.json` `proxy`
field — all mainstream dev servers support this) forwards a path
(`/api/*`) to the backend running on an **unpublished, internal-only** port
in the same container. The browser only ever talks to one origin. No CORS
needed (same-origin). No cproj changes required — this works today.

**B — A second, real, published port for the backend**, reachable directly
from the Mac's network — required when something *other than the browser
hitting the frontend* needs to reach the backend: a native mobile client
running in the Simulator/emulator during dev, a third-party webhook sender,
a second team's service. **cproj cannot do this today.** There is no
supported way to add a second published port to a project — hand-editing the
generated `docker-compose.yml` is overwritten on the next `up`, and there is
no second port field anywhere in the data model. This is a real, tracked gap
— see `docs/migration-guide-gaps.md`.

**Decision tree:**
- Only the browser (via the web frontend) ever needs to reach the backend →
  **use A.** Simple, works today, nothing to track.
- A native mobile client, or anything else outside the project's own
  frontend, needs direct access → **you need B, which doesn't exist yet.**
  Record the need in the gaps doc (one entry per *kind* of need, not per
  project) and, for now:
  - Still wire the web frontend through A (it costs nothing extra and keeps
    the browser off a second port even while the gap is open).
  - Leave mobile-client development against whatever setup it already used
    (a previous native run, a staging environment, ...) until B lands as a
    real phase. Don't invent a stopgap second port by hand-editing the
    compose file — it won't survive the next `up`, and it's exactly the kind
    of unreviewed one-off `docs/migration-guide-gaps.md` exists to prevent.

- More than one of the project's own frontend/UI apps needs to be reached
  directly by a browser (not just a backend) — there's no proxy relationship
  between two sibling frontends, so each one beyond the first has the same
  shape as case B. File it in the gaps doc the same way.

**STOP:** if this project has (or will soon have) a native mobile client
that needs the backend directly, say so explicitly before continuing past
step 8 — confirm A is still worth wiring now versus waiting, and confirm the
gaps entry is filed.

---

## Part 3 — Situational instructions (check each; most won't apply)

- **Catalogue service version mismatch.** The project pins a specific
  major version of postgres/redis/etc. that differs from the catalogue's.
  Default to the shared catalogue image; only add a pinned, differently-named
  catalogue entry (e.g. a second key rather than changing the shared one —
  other projects use the shared one) if something actually breaks under the
  newer version. Don't pre-emptively pin on the assumption it might matter.

- **The catalogue has nothing for a service the project needs at all**
  (search index, message queue, object store, mail catcher). Add a
  `services.yml` entry using an official pullable image, same schema as the
  existing entries. Never a custom-built image for a shared service —
  disk-frugality and "shared official images" both apply.

- **More than one of the project's own processes need to run** (an API plus
  a worker plus a scheduler). Each is just another process started by hand
  in the same one dev container — not a cproj concept, no extra ports unless
  Part 2 applies to it too.

- **Existing volume data needs to survive the move**, rather than starting
  fresh. Run a temporary container that mounts both the old bind-mounted (or
  Docker-volume) data and the new catalogue-provisioned volume, and copy
  between them (`tar`/`cp`) before the first real `up`. Do this once, before
  anything writes to the fresh volume.

- **The project has real migration tooling** (alembic, Prisma, knex, ...)
  that actually runs against the database (many projects declare one but
  don't wire it up — check before assuming). Run it once against the fresh
  database after the first `up`, the same as you would locally.

- **Existing dev/test scripts assume services are reachable at
  `localhost:<port>`.** That's true only from the **Mac** (the published
  port is a debugging tap) — from *inside* the dev container, services are
  reached by name, not `localhost`. Decide, per script, whether it should run
  on the host (using the published port, unmodified) or inside the container
  (needs its hostnames updated).

- **The project's dev setup assumes multiple hostnames/subdomains**
  (tenant-per-subdomain routing, cookie-domain assumptions). cproj gives you
  one origin on one Mac-reachable port. If the app has a path-based or
  single-host fallback, use it for local dev; otherwise this is a real
  limitation to flag, not something to solve with an ad hoc `/etc/hosts`
  hack baked into the migration.

- **Retiring the project's own old per-service compose file / Dockerfile.**
  Their job moves to the generated compose + the shared base image. Safe to
  leave them in place, unused (useful as prod-deploy reference) — deleting is
  the project owner's call, not a required step.

- **An env var points at a genuinely external, LAN-only service** (a local
  LLM server, lab/dev hardware, a teammate's machine) by a raw IP or
  non-`localhost` hostname. Leave it as-is — Docker's default bridge network
  reaches the LAN the same way the Mac does — but confirm reachability from
  inside the container once, after the first `up`, rather than assuming it.

- **The project needs a language/toolchain the base image doesn't have at
  all** (something other than Node or Python today). This is bigger than a
  situational fix — it's the same shape of change Phase 11 made for Python.
  Don't improvise a per-project Dockerfile addition; file it in
  `docs/migration-guide-gaps.md` instead.

---

## Appendix — prompt to review a new project against this guide

Copy-paste this (with a real path filled in) into a fresh session to have an
agent check a specific project against this guide **before** migrating it,
and propose updates to the guide from what it finds — without ever naming
the project in those updates.

> Read `docs/migration-guide.md` and `docs/migration-guide-gaps.md` in full.
> Then survey the project at `<PATH>` the same way Part 1, step 1 of the
> guide describes (compose files, Dockerfiles, env files, package manifests,
> dev scripts, any seeded-filename collisions) — read-only, don't change
> anything there or in this repo yet.
>
> For everything you find that this project needs and the guide doesn't
> already cover:
> - If it's a one-off already covered by an existing situational item in
>   Part 3, or genuinely doesn't generalize beyond this one project, don't
>   add it — note it to me instead, out loud, and leave the guide alone.
> - If it's a kind of thing likely to recur across other migrations, propose
>   a new Part 3 situational item (or a correction to Part 1/2 if something
>   there is actually wrong or incomplete) — phrased entirely generically,
>   describing the *situation and the instruction*, never this project by
>   name or anything identifying about it.
> - If it needs a cproj/app capability that doesn't exist (like Part 2's
>   second-port gap), propose a new entry for `docs/migration-guide-gaps.md`
>   instead of a workaround — also phrased generically.
>
> Show me every proposed addition before editing either file, grouped by
> which file it belongs in. Ask me directly wherever you're genuinely unsure
> whether something generalizes, whether it belongs in Part 1 vs Part 3, or
> how to phrase an instruction — don't guess past ambiguity into the guide.
> Do not perform the actual migration.
