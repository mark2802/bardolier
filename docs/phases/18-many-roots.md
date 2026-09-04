# Phase 18 — many roots

**Goal:** Let projects live in more than one place — typically an internal-disk
root and an external SSD root at the same time — without any of the four
mechanisms that assume a single root going quietly wrong.

**Grounding.** Everything that reads projects goes through
`discoverProjects(config)`, which reads one `config.ssd_root`. Generalising
that is easy; the danger is in the three callers that are only correct because
the scan is total. `assignedPorts` guarantees §5 uniqueness by scanning *every*
manifest — a scan that silently omits an unreadable root hands out a port that
is already taken. `volumes.ts` derives orphans from what the manifests still
claim, and refuses (`SSD_NOT_MOUNTED`) rather than under-report, because being
wrong there destroys data — with N roots, an unplugged SSD would otherwise make
every SSD project's volumes look reclaimable. And container names, the compose
project name and `<project>-home` are global to Docker, so two roots each
holding a project called `api` collide destructively.

**Deliverables:**
- Config: `ssd_root` is replaced by `roots`, an ordered array of
  `{ name, path }`. Names are unique and are what the user and the app refer to
  a root by; **the first root is the default** for `new`. Duplicate names or
  duplicate paths are `CONFIG_INVALID`. `$BANDOLIER_SSD_ROOT` becomes `$BANDOLIER_ROOT`
  and replaces the whole list with a single root named after the path's
  basename — one variable, so every done-check stays hermetic with a temp dir.
  The default when nothing is configured becomes one root at `~/bandolier-projects`:
  a published tool must not assume `/Volumes/ssd` exists. (Second and last
  spend of §5's additive-only rule; see phase 17.)
- `cli/src/commands/root.ts` (new): `root add <path> [--name] | root remove
  <name> | root list`. A list-valued key cannot be edited through `config set`,
  and the app must not compose one — the same reasoning that made `catalogue`
  and `config get|set` commands in phase 6. `root remove` never touches the
  directory or anything in it; it forgets a location, and says so.
- `projects.ts`: `DiscoveredProject` gains `root` (the root's name).
  `Discovery` gains `roots: [{ name, path, mounted }]` and keeps `mounted` as
  "at least one root is readable" — `status` must never fail and must still
  list what it can see. `findProject` returns every match; a name found in two
  roots is `PROJECT_AMBIGUOUS` naming both directories, never a guess, because
  the two would share a container name and a home volume.
- **`assignedPorts` and `volumes.ts` refuse a partial view.** New error
  `ROOT_UNREADABLE`, naming the roots that could not be read. Allocation and
  the orphan scan both raise it; `status` catches it exactly as it catches
  `SSD_NOT_MOUNTED` today and reports an empty orphan list. This is the single
  most dangerous edge in the phase and gets its own done-check assertions.
- `new`: `--root <name>`, defaulting to the first. Unknown name is
  `INVALID_ARGUMENT` naming the configured roots; unreadable target root is
  `ROOT_UNREADABLE`. `PROJECT_EXISTS` now means "in any root".
- `status`: `StatusProject.root` and a top-level `roots` array (both additive).
  `ssd.root` keeps reporting the default root's path so the existing field
  stays meaningful. `list`: `ListedProject.root`.
- `doctor`: the `ssd` finding keeps its id (frozen enum) and enumerates every
  root with its state; `ok` is false only when none is readable.
- `eject [root]`: unambiguous with one removable root, otherwise the argument
  is required and its absence is `INVALID_ARGUMENT` naming the candidates.
  `EjectOutput` gains `root`. `down-all` stays global — it is about containers,
  which do not belong to a root.
- App: a root picker in `NewProjectPanel`; the root shown on each project row;
  Preferences edits the list through `root add`/`root remove` rather than a
  text field; `EjectPanel` targets a root. New Swift models for the three root
  payloads plus the two error codes.
- `cli-spec.md` §3 (layout is now per-root), §5 (uniqueness is across roots),
  §6 (new Roots section, `eject`, `new --root`), §7, §8; `CLAUDE.md`'s ports,
  orphan and eject paragraphs.

**Landing order within the phase:** config and `root *` first, then discovery,
then the allocator and orphan-scan refusals, then the command surfaces, then
the app. The intermediate state after step two — several roots configurable by
hand, everything else single-root-shaped — is a real, testable state; the
allocator and volume refusals must not be left for last.

**Non-goals:** no moving projects between roots (phase 19); no per-root
catalogue or per-root config beyond name and path; no re-allocation of ports
when a root is added — uniqueness is enforced going forward, and an existing
collision between two roots that were previously separate is reported by
`doctor`, not silently repaired.

**Done-check:** two temp roots. Projects in both are listed, with their root,
by `status` and `list`; a port allocated in root A is not handed out again in
root B; **with root B made unreadable, `service add` in root A fails
`ROOT_UNREADABLE` rather than allocating, and `volumes list` fails
`ROOT_UNREADABLE` rather than reporting root B's volumes as orphans, while
`status` still succeeds and lists root A's projects with an empty orphan
list**; `new` with a name that exists in the other root fails `PROJECT_EXISTS`;
a name planted by hand in both roots makes `up` fail `PROJECT_AMBIGUOUS`;
`root remove` leaves the directory untouched; `eject` with two roots and no
argument fails `INVALID_ARGUMENT` naming both. Land as
`test/phase18-done-check.sh` plus a section in `test/regression.sh`
(`LAST=18`); unit coverage in `test/phase18.test.ts`.
