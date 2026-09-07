# Phase 20 — clone a project

**Goal:** `bardolier clone <source> <name>` — a second project shaped like one
that already works, with its own ports, in one command instead of six.

**Grounding.** Reproducing a project by hand is `new`, then a `service add` per
service, then a `port add` per extra port, then `deps add`, with the archetype
remembered correctly. Every step is a chance to end up with a project that is
nearly, but not exactly, the one it was meant to resemble. `project.yml` already
holds all of it (§4.2); a clone is that manifest with a new name, fresh ports
and a fresh `created`.

The expensive question is what *else* travels, and the answer differs per folder
of §3:

- `work/`, `local/` — the user's own files. Large, usually; recoverable from a
  remote, sometimes.
- `data/` — service state, which nothing else has a copy of, and which copies
  **torn** from a running Postgres.
- `home/` — the container's `$HOME`: the `claude login`, ssh keys, dotfiles,
  shell history.

So the default clone copies the **shape** — manifest fields only — and
`--with-content` copies **all four** byte-for-byte. One flag, naming the
expensive thing explicitly, which is the posture `delete --purge` already takes.

*Amended after the phase shipped* (owner's decision): `home/` was initially
excluded under every flag, because Claude Code files its transcripts by working
directory and every dev container works in `/work` (§9) — so a copied home makes
`claude --continue` in a fresh clone resume the *source's* last conversation.
That consequence is real and is documented in §6, but it is the only one: the
homes stay separate afterwards, nothing diverges, and this is a personal tool
whose clones never leave the owner's own disks. Clone means an identical copy.

**Deliverables:**
- `bardolier clone <source> <name> [--root <name>] [--with-content]`
  (`commands/clone.ts`).
  - `name` is validated by `new`'s `NAME_PATTERN` and must not exist in **any**
    root — `PROJECT_EXISTS`, for the reason `new` checks globally: two projects
    sharing a name share a container name (§9).
  - `--root` defaults to **the source's** root, not `roots[0]`: a clone is
    another one of these, and that is where its kind lives. An unreadable target
    is `ROOT_UNREADABLE`, an unknown one `INVALID_ARGUMENT` naming the
    configured roots.
  - Copied from the source manifest: `archetype`, `base_image`,
    `extra_packages`, the attached service keys, and each extra port's
    `container_port`. **No host port is copied.** `app_port`, every service
    `host_port` and every extra-port `host_port` are allocated fresh through
    `allocator.ts` — which already scans the source's manifest, so it cannot
    hand back a port the source holds (§5). `created` is `ctx.now()`.
  - `docker-compose.yml` is rendered from the new manifest, never copied: a
    generated file is never authoritative (`INTENT.md` invariant 7).
    `work/CLAUDE.md` is re-seeded from `scaffold.ts` unless `--with-content`
    brought one. `.bardolier/` is not copied — the handoff note is a record of
    the source's sessions, not the clone's.
  - `--with-content` requires the source **stopped** (`PROJECT_RUNNING`). A
    shape-only clone reads nothing but `project.yml`, mutates nothing, and so
    needs nothing stopped — there is nothing it could tear.
- `transfer.ts` — copying a project directory, shared with phase 21:
  - **Staged, then swapped.** Content lands in
    `<target root>/.<name>.incoming` and is `rename`d to
    `<target root>/<name>` only once complete. Discovery skips dot-prefixed
    entries (`projects.ts`), so a clone in progress is never a half-project
    `status` can see, and an interrupted one leaves a directory that names
    itself. `new` writes its manifest *first*, deliberately; a multi-gigabyte
    copy inverts that reasoning.
  - **Space is checked before any byte moves** — `statfsSync` on the target
    against `directorySize` of the sources — refusing with a new §2 code
    `INSUFFICIENT_SPACE` that names both numbers. Filling a disk halfway
    through is the failure that costs the most to undo.
  - `cpSync(..., { recursive: true, preserveTimestamps: true, verbatimSymlinks:
    true })`: pure Node, no spawn, so nothing new joins `Context` and the whole
    path runs against a temp dir in a unit test. Any failure removes the staging
    directory before rethrowing.
- `CloneOutput` in `model/lifecycle.ts` and `clone.schema.json` — the `new`
  fields (`project`, `manifest_path`, `compose_path`, `seeded`, `services`) plus
  `source`, `with_content` and `bytes_copied`. Declared in
  `commands/registry.ts` under `Projects`.
- `cli-spec.md` §6 (Projects) and §2 (`INSUFFICIENT_SPACE`); `CLAUDE.md`'s code
  map gains `transfer.ts`.

**Non-goals:** no menu-bar surface — the contract is driven from the terminal
with `--json` first, and an app phase follows if it is wanted. No selective
content (`--with-data` without `--with-work`): the combination anyone actually
wants is a shape clone plus their own `git clone` into `work/`. No `--force`
overwriting an existing project, and no change of any kind to the source.

**Done-check** — folded into `test/lifecycle-done-check.sh` and
`test/lifecycle.test.ts`, where `new` and `delete` already live:

- a shape clone of a project with postgres, an extra port and an extra package
  yields a manifest identical to the source's but for `name`, `created` and
  **every host port**, with compose rendered from the new manifest;
- the source's `project.yml` is byte-identical afterwards;
- `--with-content` reproduces a file written under `data/postgres/`, one under
  `work/` and one under `home/`;
- `--with-content` against a running source is `PROJECT_RUNNING`, while a shape
  clone of that same running source succeeds;
- cloning to a name that exists in another root is `PROJECT_EXISTS` and leaves
  no directory behind;
- clone → `up` → `status` shows both projects running on disjoint ports;
- unit tests make the copy throw and assert nothing is discoverable and no
  staging directory survives, and drive `INSUFFICIENT_SPACE` from a stubbed
  free-space read.
