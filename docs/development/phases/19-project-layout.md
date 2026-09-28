# Phase 19 — the project layout: work, data, local, home

**Goal:** A project directory stops being a git repository with bardolier's files
scattered through it, and becomes four bind-mounted folders around them. Service
data moves out of Docker's disk image and onto the root the project already
lives on.

**Grounding.** Two problems share one cause. Service data is a named Docker
volume, so it lives in `Docker.raw` on the internal disk no matter which root
the project is on — the disk with the least room holds the data that grows
fastest. And the project directory *is* the repo root, so `project.yml`,
`docker-compose.yml`, `.gitignore`, `.dockerignore` and `.bardolier/` are all
destined for someone's `git status`; dev-environment files end up in a shared,
committed file. Putting the data under an ignore rule would make that worse and
add a hazard: ignored files are what `git clean -xdf` deletes, so a database
inside the working tree is one routine reset from being destroyed.

Separating the repo from the project folder fixes both. Nothing bardolier makes
is inside a repository, so nothing needs ignoring — by anyone, in any file — and
the data sits beside the code on the same disk, outside any working tree.

**The measurement that says this is safe.** Postgres 17 and Mongo 7 were run
with their data directories bind-mounted from an APFS external SSD (mounted
`noowners`). `initdb` and WiredTiger both started clean — no permission
failure, which is the usual objection — and data survived container
destruction. Steady-state pgbench is 0.69x native for writes and 0.88x for
reads; bulk load is 0.34x, the one case where the penalty is visible.

    <root>/<project>/
    ├── project.yml           manifest — never inside a repo
    ├── docker-compose.yml    generated — never inside a repo
    ├── .bardolier/           handoff.md
    ├── work/   → /work       repos, cloned or inited by the user; empty at `new`
    ├── data/   → /data:ro    service data, one directory per attached service
    ├── local/  → /local      miscellany that is neither repo nor service data
    └── home/   → /state/home the dev container's $HOME

Every bind is relative to the compose file's own directory, so the file still
holds no absolute paths and a project is still a self-contained, relocatable
folder — now genuinely self-contained, because the data is in it.

**Deliverables:**
- `compose.ts`: the dev service binds all four directories; `working_dir` stays
  `/work`. `/data` is mounted **read-only** in the dev container — visible for
  inspection, because writing into a live data directory from another container
  corrupts it. Each attached service binds `./data/<catalogue key>` at its
  catalogue `mount`. The top-level `volumes:` block reduces to the shared
  toolchain cache (`external: true`); the per-service and `$HOME` volumes, their
  `bardolier.project` / `bardolier.service` / `bardolier.role: home` labels, and
  `homeVolumeName` in `naming.ts` all go.
- **Directories are created before compose runs, by both `new` and `up`.** A
  missing bind source is created by Docker as root, which would leave `$HOME`
  unwritable by the container's own uid. `up` ensures all four every time, so a
  hand-deleted folder heals instead of breaking the container.
- `data/.metadata_never_index` at creation. Spotlight indexing a multi-GB data
  directory wastes effort and puts `mds` on the volume — the holder `eject`
  already has to filter as non-actionable. Cheaper to prevent than to work
  around.
- `scaffold.ts`: the `.gitignore` and `.dockerignore` seeds are removed. There
  is no repo root to seed, and nothing has ever used a project as a build
  context (`deps.ts:83` builds from a generated context under the config dir).
  The project `CLAUDE.md` is written to `work/CLAUDE.md`, where the agent's cwd
  can find it and no clone will contain it. `COMMON_IGNORE` goes with them.
- `volumes.ts`: a data directory left by `service remove` is an orphan of the
  project that holds it — `ls data/` minus the manifest's service keys, needing
  only that one root readable, with no labels and no cross-root reasoning. The
  global named-volume scan shrinks to the shared caches, keeping its existing
  refusal semantics because it still needs every manifest. Entries gain `kind`
  (`volume` | `directory`), `path` and `bytes`; `volumes rm` accepts both kinds.
- `delete`: `--keep-data` is removed — with the data inside the directory,
  "remove the directory but keep the data" cannot mean anything. Plain `delete`
  refuses with a new §2 code `PROJECT_HAS_DATA` when `data/` or `home/` is
  non-empty, naming what it would destroy and its size; `--purge` removes the
  folder. `--force` still governs the prompt, not the data.
- `handoff.ts`: `work/` may hold several repos, so the note walks `work/*/` and
  reports each, or says there are none. Everything stays best-effort: no repo,
  no agent, no session and no credentials each degrade the note rather than
  failing the stop. `up`'s `GIT_*` passthrough is unchanged — it reads the
  host's git config, not a repo.
- `status` gains `work_dir` (additive), so the app never composes a path.
- Schemas, `BardolierModels.swift` and `test/app-models.test.ts` follow.
- `cli-spec.md` §4.2 (the layout), §6 (`delete`), §2 (`PROJECT_HAS_DATA`), §10
  (seeds); `CLAUDE.md` replaces its "`$HOME` is a volume" and "an orphan is
  derived" paragraphs with what is now true.

**The one contract break, deliberately.** The catalogue's `volume` field is
removed from the file format and from `bardolier catalogue`; a service's data
directory is its catalogue key. This violates "schema changes are additive
only" (§5). It is taken because the rule exists to keep an older app build
working against a newer CLI, and there is no such build: the project is
pre-publication and every existing project was deleted before this phase began.
Recorded here so it is a decision rather than an oversight.

**Non-goals:** no migration path — the three existing projects were deleted, and
a tool with no users owes no upgrade. No `move` command: with the data inside
the folder it collapses to a directory rename plus the guardrails `mv` lacks,
and it is a small phase of its own once this lands. No moving the shared
Gradle/uv caches off the internal disk — they are shared between projects and
re-downloadable, which is exactly what the internal disk is for. No per-service
choice of internal-vs-root storage: one rule, no second setting to disagree
with the first.

**Done-check** (`test/phase19-done-check.sh`, plus a section in
`test/regression.sh` with `LAST=19`; unit coverage in `test/phase19.test.ts`):
`new` creates the four directories and no others, seeds `work/CLAUDE.md` and
nothing else, and writes no `.gitignore` anywhere; the compose file contains
four relative binds, `:ro` on `/data`, and no named volume but the external
cache; a project with postgres attached writes files under `data/postgres/`
that are visible from the host and survive `down` then `up`; `git init` in
`work/` followed by `git status` is clean and `git clean -xdf` there leaves
`data/` untouched; the dev container sees `/data` read-only and cannot see
`project.yml` at all; `service remove postgres` keeps `data/postgres/` and
`volumes orphaned` reports it as a `directory` with a size; plain `delete`
refuses `PROJECT_HAS_DATA` and `--purge` removes everything; deleting `home/`
by hand and running `up` recreates it writable.
