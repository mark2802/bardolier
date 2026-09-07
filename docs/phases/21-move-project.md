# Phase 21 — move a project to another root

**Goal:** `bardolier move <name> --root <target>` — a project changes disks
without changing anything about itself.

**Grounding.** Phase 19 left this explicitly: "No `move` command: with the data
inside the folder it collapses to a directory rename plus the guardrails `mv`
lacks, and it is a small phase of its own once this lands." This is that phase.

*Why* it collapses that far is what makes a move safe, and is worth stating.
Every bind in the compose file is relative to the compose file's own directory
(§9), so the file holds no absolute path; inside the container everything is at
`/work`, `/data`, `/local` and `CONTAINER_HOME` whatever root the project sits
on. The manifest names no path either. A project that has moved is therefore
byte-identical to the project that was there before, and its ports do not move —
invariant 4 holds by doing nothing at all.

What `mv` lacks is the three refusals: that the containers are down, that the
bytes will fit, and that the source is not deleted until the copy is complete.

**Deliverables:**
- `bardolier move <name> --root <target>` (`commands/move.ts`).
  - Requires the project **stopped** — `PROJECT_RUNNING`. Moving the bind
    sources out from under live containers leaves them running against a
    directory that no longer exists (§2, no partial mutation of running state).
  - `--root` is required; naming the root the project is already in is an
    idempotent no-op success (`moved: false`), as `up` and `down` are (§2). An
    unknown root is `INVALID_ARGUMENT` naming the configured ones, an unreadable
    target `ROOT_UNREADABLE`, an occupied `<target>/<name>` `PROJECT_EXISTS`.
  - **Same device: `rename(2)`.** Two roots on one filesystem — tidying
    `~/bardolier-projects` — move instantly and atomically, with no copy and no
    window in which the project exists twice.
  - **Across devices: phase 20's staged copy, then the source is removed.**
    `rename` fails `EXDEV` between the internal disk and an SSD, so
    `transfer.ts` copies into `<target>/.<name>.incoming`, swaps it into place,
    and only then removes the source. Nothing is deleted before its replacement
    is complete and discoverable; a crash mid-copy leaves the original untouched
    and a dot-directory to clean up. There is no `--keep-source`: a copy left
    behind is a second project with the same name, which every other command
    already treats as an error (`PROJECT_AMBIGUOUS`).
  - **Nothing inside the directory is rewritten** — not the manifest, not the
    compose file, not the handoff note. The move is *reported* by the manifest's
    new location, never implemented by editing it.
- `MoveOutput` in `model/lifecycle.ts` and `move.schema.json`:
  `{ project, moved, from: { root, dir }, to: { root, dir }, bytes, mode }`,
  where `mode` is `rename | copy` — the field that tells a caller whether an
  instant operation or a multi-gigabyte one just happened. Declared in
  `commands/registry.ts` under `Projects`.
- `cli-spec.md` §6 (Projects), and §3's "self-contained, relocatable folder"
  gains the sentence naming `move` as how it relocates.

**Non-goals:** no rename — `move` changes which root holds a project, never its
name; renaming touches container names, the compose project and the seeded
`CLAUDE.md`, and is its own small phase if it is ever wanted. No target outside
the configured roots (`root add` first). No progress output during a
cross-device copy: a command writes nothing to stdout (§2), and a long silent
copy is the price of that. No repair of anything under `work/` or `local/` that
recorded its own host path — a venv or a `node_modules/.bin` symlink baked with
absolute paths is the user's to rebuild; the *container's* paths never change,
which is why that is rare rather than routine. No menu-bar surface, for the
same reason as phase 20.

**Done-check** — `test/lifecycle-done-check.sh` and `test/lifecycle.test.ts`,
with a second temp root beside the first:

- a stopped project holding a file under `data/postgres/` and a repo under
  `work/` moves between two roots: the source directory is gone, the target
  holds every file with the same content, `list` reports it under the new root,
  and `project.yml` and `docker-compose.yml` are byte-identical to before;
- `app_port` and the service host ports are unchanged, and `up` after the move
  starts the project on exactly those ports;
- moving to the root it already occupies is a success with `moved: false` and an
  untouched directory;
- a running project refuses `PROJECT_RUNNING` and does not move; an unreadable
  target is `ROOT_UNREADABLE` and leaves the source alone;
- unit tests force the cross-device path (`mode: 'copy'`) and a failure part-way
  through it, asserting the source survives intact and no staging directory is
  left behind.
