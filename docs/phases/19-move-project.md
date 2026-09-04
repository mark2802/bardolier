# Phase 19 — moving a project between roots

**Goal:** `cproj move <project> <root>` — offload a project from the internal
disk to the SSD or pull it back, without deleting and re-creating it.

**Grounding, and the honest limit.** A project's *workspace* is the only thing
that lives under a root: the compose file mounts it as a RELATIVE bind
(`.:/work`, resolved against the compose file's own directory, so the tool has
no absolute paths on the SSD). Everything else this tool makes — the
per-project `$HOME` volume, every service's data volume, the shared toolchain
caches — is a named Docker volume in Docker's own data root on the internal
disk, and is unaffected by a move. So a move relocates the repo, `node_modules`
and build output, which is usually the large part, and **does not** relocate
the postgres data or the Gradle cache. The command's output and the app must
say so rather than let the user infer otherwise.

The same relative bind is why this is cheap: nothing in the compose file, the
manifest or the allocation needs rewriting. Ports are already unique across
roots after phase 18, so a moved project keeps its ports and its connection
strings — which is the point of §5's stability rule.

**Deliverables:**
- `cli/src/commands/move.ts` (new): `move <project> <root>`.
  Preconditions, in order and with no way to skip one: the project is stopped
  (`PROJECT_RUNNING`, same rule as `service`/`port`/`deps`); the target root is
  configured (`INVALID_ARGUMENT` naming the roots) and readable
  (`ROOT_UNREADABLE`); the target holds no project of that name
  (`PROJECT_EXISTS`); the target has room (new error `INSUFFICIENT_SPACE`, from
  `statfs` on the target root against the measured source size — a half-copied
  workspace with the disk full is a worse failure than a refusal). A move to
  the root the project is already in succeeds with `moved: false` and does
  nothing.
- The move itself, two paths chosen by device:
  - Same device (`containingVolume` from phase 17 agrees for both roots) —
    `rename()`. Atomic and instant; this is the common case of two roots on one
    disk.
  - Different devices — **copy, verify, then remove the source, in that
    order.** Never remove first. Verification compares the set of relative
    paths and their sizes, and re-reads the manifest at the destination. Any
    failure removes the partial destination and leaves the source untouched,
    so a failed move is a no-op rather than a project in two half-states.
- `MoveOutput` + `move.schema.json`: `project`, `from` / `to` (root name and
  path), `moved`, `method` (`rename` | `copy`), `bytes`, and `volumes_kept` —
  the named volumes that did not move, listed by name, because that is the
  sentence the human formatter needs to print.
- App: a "Move to…" item on a stopped project's row, the target chosen from the
  configured roots. `CprojStore.activity` already disables every other mutation
  while one runs and forces a `status` refresh afterwards, which is exactly the
  behaviour a multi-second copy needs; the confirmation happens in the view.
- `cli-spec.md` §6 (a Move entry beside the Roots section) and §2 for
  `INSUFFICIENT_SPACE`; `CLAUDE.md` gains a short paragraph on why the relative
  bind is what makes this a directory move and nothing more.

**Non-goals:** no moving Docker volumes — a volume lives where Docker keeps
volumes, and relocating one is `docker` surgery this tool has no business
doing; no move while running (no hot-apply paths, per `CLAUDE.md`); no progress
percentage or streamed output — the app shows the operation as busy, and a
progress protocol would be the first streaming command in a CLI whose contract
is one JSON value per invocation.

**Done-check:** on two temp roots on the same device, `move` uses `rename`,
completes immediately, and the project then `up`s on unchanged ports with its
`$HOME` volume still attached (proving the volumes did not move and did not
need to); on two roots on different devices (a temp `dmg` or a stubbed device
check), `move` copies and the source is gone only after the destination
verifies; with the destination made unwritable mid-way, the source survives
intact and no partial destination remains; `PROJECT_RUNNING`, unknown root,
name collision in the target, and `INSUFFICIENT_SPACE` all refuse before
anything is written; a same-root move reports `moved: false`. Land as
`test/phase19-done-check.sh` plus a section in `test/regression.sh`
(`LAST=19`); unit coverage in `test/phase19.test.ts`.
