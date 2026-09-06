# Migrating an existing project onto bardolier

**Audience:** whoever (human or agent) is doing the migration. Written as a
runbook to execute, not background reading — follow it in order. Steps marked
**STOP** need a decision from the project's owner before continuing; don't
guess past them.

**Not a phase spec.** This changes no CLI behaviour, so it carries no schema
and no done-check. When a step below turns out to need one — the project
needs something bardolier cannot do yet — write that down in
`docs/migration-guide-gaps.md` (last section) and route around it for now.
Don't hand-invent the capability per project; a generated file a hand-edit
"fixes" today is overwritten the next `up` (`docker-compose.yml` is generated,
never patched — `cli-spec.md` §9).

This guide assumes the project is a **web** archetype migration (a frontend,
maybe a backend API, maybe backing services) — by far the common case. Where
something is `ios`/`android`-specific it says so.

---

## The shape you are migrating into

A bardolier project directory is **not a repository** (`cli-spec.md` §3). Its
own files sit at the top; everything else lives in four bind-mounted folders:

```
<root>/<name>/
  project.yml, docker-compose.yml, .bardolier/   bardolier's own, not yours
  work/   → /work         the repositories, one directory each
  data/   → /data:ro      service data, one directory per attached service
  local/  → /local        neither repository nor service data
  home/   → /state/home   the dev container's $HOME
```

Two consequences run through every step below. **The repo you are migrating
becomes `work/<repo>/`**, not the project directory itself — so nothing
bardolier writes is inside a working tree, there is nothing to gitignore, and a
`git clean -xdf` cannot reach the data. And **service data is a directory on the
same disk as the project**, visible from the Mac at `data/<svc>/`, rather than a
Docker volume on the internal disk.

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
- The repo's own `CLAUDE.md`, if it has one — nothing collides with it now,
  but it does need reading against what `new` seeds beside it (step 5).
- Anything large that is neither code nor service data — datasets, model
  checkpoints, media, scratch notebooks. `local/` is where those go now, so
  decide per item rather than dragging them into the working tree (step 4).
- Whether there's a `.git` at all, and if so `git remote -v` and current
  branch, and whether anything local is uncommitted or unpushed — this is
  exactly what decides which of step 4's three cases applies.

### 2. Decide the archetype and the service mapping

- Archetype is `web` unless the project is actually a native mobile client
  with no web/API half (then see the `ios`/`android` phases instead — this
  guide doesn't cover that side), or the project has no frontend/dev-server
  at all — a research/analysis codebase, a CLI tool, a batch pipeline, a
  redistributable package — in which case it's `library`: same base image
  and toolchain as `web`, but no `app_port` and nothing published. Most of
  the rest of this guide (step 6's service hostnames, step 8, and all of
  Part 2) only applies when there are backing services or a dev server to
  worry about — skip what doesn't apply.
- For each backing service in the old compose file, decide:
  - **It's postgres/redis/mongo and an official image** → use the catalogue
    entry as-is. Don't pin a project-specific version unless step-9-style
    testing shows an actual incompatibility (see Part 3, "catalogue version
    mismatch").
  - **It's some other official, pullable image** (queue, search, object
    store, mail-catcher, ...) → add a `services.yml` entry for it (same
    shape as the existing ones: `image`, `container_port`, `host_port_base`,
    `mount`, optional `env` — there is no `volume` key, the entry's own key
    names its data directory). This is additive and shared across every
    project, not a one-off.
  - **It's the project's own code** (an API, a worker) → it is never a
    catalogue service. It runs as a process inside the one dev container,
    same as the frontend. See step 8.

### 3. Create the project

```
bardolier new <name> --archetype web --services <postgres,redis,...>
```

This assigns ports and writes `project.yml`, a generated `docker-compose.yml`,
the four folders above, and one seeded file: `work/CLAUDE.md`. Do this
**before** moving the real source in — `new` refuses (`PROJECT_EXISTS`) if a
project of that name already exists in any root, and it's the only thing that
assigns ports.

### 4. Get the source in — move, clone, or copy, depending what it is

**It lands in `work/<repo>/`** — a directory per repository, beside the seeded
`work/CLAUDE.md`, never the project directory itself. (`down`'s handoff note
walks `work/*/`, so a tree dumped directly into `work/` is invisible to it.)
Repos that used to be checked out side by side each become their own directory
under `work/`; they share one container and one network.

However it arrives, exclude anything regenerable that shouldn't cost SSD
space: `node_modules`, `.venv`, `__pycache__`, build output (`.next`, `dist`,
`build`), `.DS_Store`, tool caches (`.mypy_cache`, `.pytest_cache`). These are
already excluded by the project's own `.gitignore` in most cases — check.
Don't treat "excluded by the project's `.gitignore`" as a synonym for "safe
to skip," though — a `.gitignore` also commonly excludes large raw datasets,
model checkpoints, or media assets purely for size, not because they're
regenerable. Check what a gitignored entry actually *is* before leaving it
behind; anything irreplaceable still needs to move (by hand, not via git)
even though git itself will never carry it. Put that material in `local/`
rather than back inside the working tree: same disk, mounted at `/local`, and
no fresh clone or `git clean` can lose it.
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
  history-going-forward that every other bardolier project has) or leave it
  untracked; either is fine, but it's the project owner's call, not a
  default this guide should make for you.

### 5. Leave the repo's own files alone — nothing collides any more

There is nothing to merge or clobber. bardolier seeds one file,
`work/CLAUDE.md`, and the repo arrived as `work/<repo>/`, a directory below it:

- **`.gitignore` / `.dockerignore`** — the repo's own, untouched. bardolier
  adds no entry to either; its files are above `work/` and inside no working tree,
  so there is nothing left to ignore.
- **`CLAUDE.md`** — two files, not one. bardolier's `work/CLAUDE.md` says where
  the agent is (the layout, `/data` read-only, service names, the boundary);
  the repo's own `work/<repo>/CLAUDE.md` keeps its dev-workflow content
  unchanged. Claude Code reads both — the parent and the one in the working
  directory — so they layer instead of competing. Don't copy the repo's
  content up, and don't paste bardolier's sections down into a file that is
  about to be committed.

Read the repo's `CLAUDE.md` anyway, for one thing: instructions that assume
the old shape — `docker compose up` from the repo root, `localhost:5432`
connection strings, a build step that must run on the host. Those are wrong
here, and correcting them is a real edit to that repo (step 6, Part 3).

### 6. Point the environment at service names, not `localhost`

Every connection string that used to read `localhost:5432` /
`localhost:6379` / etc. now reads the service name from the catalogue
(`postgres`, `redis`, ...) — they're sibling containers on the project's own
Docker network. Reconcile any database/user names the project's code expects
against what the catalogue actually provisions (it interpolates
`{project}` for the database name, and won't set a user unless you told it
to) — update the project's env, don't fight the catalogue.

Nothing in the env should name a data *path*, either: each service's data
directory is `data/<svc>/` in the project, bound at the catalogue's `mount`.
It is readable from the Mac, and mounted **read-only** into the dev container —
inspect it from in there, never write it, because a live database written from
a second container corrupts.

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
bardolier up <name>
```
Shell in (or let the app) — you land in `/work`, so `cd <repo>` first — and
install dependencies for whatever runs in the container (`uv sync` /
`npm install`, per repo, per process), then start each process by hand — this
container is a devbox to exec into, nothing supervises processes for you.
Then verify from the **Mac**, not from inside the container:
`bardolier status <name>` for the URL, load it in a browser, confirm a page that
hits the backend actually gets data, confirm the backend can reach its
services by name (archetypes with a dev server; a `library` project instead
just runs its scripts/test suite by hand inside the container and confirms
they complete — there's no URL to load). `bardolier status` also reports `dir`
and `work_dir`, so no path here needs composing by hand.

Two checks worth doing once, because they are what the layout bought: after
the first write, `ls <dir>/data/<svc>/` on the Mac shows the database's files
on the project's own disk; and `git status` in `work/<repo>/` is clean, with no
bardolier file to ignore.

### 10. Note anything the project needed that bardolier couldn't do

If step 8, or anything else, needed a capability bardolier doesn't have — don't
build a per-project workaround for it. Add it to
`docs/migration-guide-gaps.md` and route around it in this migration (Part 2
covers the port-policy decision itself, including a second published port,
which `bardolier port add` now handles).

---

## Part 2 — The port-policy decision

bardolier's `web` archetype publishes **exactly one *fixed* port** — the
frontend's dev server, `app_port`. A project with its own backend process, or
a second UI app, wants *that* process reachable by *something* — the question
is by what, and there are two shapes:

**A — Proxy through the one fixed port.** The frontend dev server (Next.js
`rewrites()`, Vite's `server.proxy`, CRA's `package.json` `proxy` field — all
mainstream dev servers support this) forwards a path (`/api/*`) to the
backend running on an **unpublished, internal-only** port in the same
container. The browser only ever talks to one origin. No CORS needed
(same-origin). No bardolier changes required.

**B — A second, real, published port**, reachable directly from the Mac's
network — needed when something *other than the browser hitting the
frontend* must reach a process directly: a native mobile client running in
the Simulator/emulator during dev, a third-party webhook sender, a second
team's service, or a second UI app of the project's own with no proxy
relationship to the first. `bardolier port add <project> <name>
--container-port <n>` declares one — independent of archetype, so it also
covers a `library`/`ios`/`android` project that wants a browser-reachable dev
tool (a notebook server, a debugger UI) and otherwise publishes nothing at
all. See `cli-spec.md` §5.1.

**Decision tree:**
- Only the browser (via the web frontend) ever needs to reach the backend →
  **use A.** Simple, one origin, nothing to declare.
- A native mobile client, a second UI app, or anything else outside the
  project's own frontend needs direct access → **use B**: `bardolier port add
  <project> <name> --container-port <n>`, then point the client at
  `http://localhost:<host_port>` (from the command's own output, or `bardolier
  status`/`port list` afterwards — never guess or hand-compose the host
  port). Still wire the web frontend through A too, where it applies — the
  two are not exclusive, and A costs nothing extra.
- An interactive dev tool on a `library`/`ios`/`android` project needs a
  browser to reach it → **use B** the same way; there is no `app_port` to
  proxy through on those archetypes.

Don't hand-edit `docker-compose.yml` to add a port — it is regenerated on
every `up`/service change and a hand-added `ports:` entry is silently lost.

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
  in the same one dev container — not a bardolier concept, no extra ports unless
  Part 2 applies to it too.

- **Existing service data needs to survive the move**, rather than starting
  fresh. The destination is a plain host directory now — `<dir>/data/<svc>/`,
  created by `new`. If the old data was itself a bind mount, copy it in
  directly on the Mac; if it was a Docker volume, run a throwaway container
  mounting both the old volume and that directory and copy between them
  (`tar`/`cp`). Either way copy the data directory's *contents*, not the
  directory itself, and do it **before the first `up`**, while it is still
  empty. Prefer a dump/restore across a major-version gap — the catalogue's
  image may be newer than whatever wrote the files.

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
  (tenant-per-subdomain routing, cookie-domain assumptions). bardolier gives you
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

- **The project's toolchain needs OS-level packages the base image doesn't
  ship** — Playwright's browser dependencies (`libnss3`, `libatk-bridge2.0-0`,
  …) are the recurring case, but anything the old Dockerfile ran `apt-get
  install` for beyond the base image's own kit qualifies. `bardolier deps add
  <project> <package...>` (stopped project only) declares one or more apt
  package names; `bardolier up` then builds a derived image with them installed
  and switches the dev container to it — nothing to hand-edit, and nothing
  installed at container-runtime (there's no root there, and `down` throws the
  writable layer away regardless). `bardolier deps remove <project> <package...>`
  undeclares them; `bardolier deps list <project>` shows what's declared and which
  image the container currently resolves to. See `cli-spec.md` §6 (Deps),
  §4.2, §9. This is for OS packages only — a genuinely new language/toolchain
  is the different, bigger gap below.

- **The project's toolchain includes something installed by its own
  installer script** — an agent skill pack such as gstack, a version manager,
  anything shipping a `curl | sh` installer. It is neither an apt package
  (`deps add` is apt-only, and its derived image is shared by every project
  declaring the same set) nor big enough to be the toolchain gap below.
  Installers default to `$HOME`, and `$HOME` is the project's own `home/`
  directory now (§3): same disk as the project, survives `down` and any Docker
  prune, and a plain `delete` refuses (`PROJECT_HAS_DATA`) rather than taking
  it. So let the installer put it there — the old advice to redirect
  everything under `/work` and symlink back buys nothing any more, and it put
  tool state inside a repository. Two things still need deciding. Anything
  that is *work rather than tooling* (a checkout the tool clones, generated
  assets you want on the Mac) is better under `/work` or `/local`, where it is
  visible without exec'ing in. And any `PATH` the tool needs goes in the repo's
  `.claude/settings.json` `env` block — the generated compose file cannot
  extend `PATH`, because `${PATH}` there substitutes the **Mac's** value. What
  is still missing is reproducibility: the install is a sequence of commands
  typed once, and nothing records how to redo it on another machine — leave a
  short script in `local/` saying what you ran. See "Persisting user-space
  tooling installed inside the container" in `docs/migration-guide-gaps.md`.

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
> dev scripts, instructions in the repo's own `CLAUDE.md` that assume the old
> shape, large material that is neither code nor service data) — read-only,
> don't change
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
> - If it needs a bardolier/app capability that doesn't exist (check
>   `docs/migration-guide-gaps.md`'s Open section first — it may already be
>   tracked), propose a new entry instead of a workaround — also phrased
>   generically.
>
> Show me every proposed addition before editing either file, grouped by
> which file it belongs in. Ask me directly wherever you're genuinely unsure
> whether something generalizes, whether it belongs in Part 1 vs Part 3, or
> how to phrase an instruction — don't guess past ambiguity into the guide.
> Do not perform the actual migration.
