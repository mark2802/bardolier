# Phase 31 — `bardolier teardown`

**Goal:** Reverse the README's Install section. Phase 28's own non-goals said
"no uninstall command — removing a symlink is `rm`," true for the symlink
alone but not for what accumulates around it: running containers, a config
file with a root list, a root-index cache, and (optionally) multi-gigabyte
base images. A user asking "how do I completely remove this" needs one
command that undoes all of it — **except project data**, which must never be
in scope: a teardown that could destroy a project's `work`/`data`/`home` on a
typo is a bigger risk than the disk space it would reclaim.

**Deliverables:**
- `cli/src/install.ts`: `unlinkOne` (the inverse of `linkOne` — same
  conservatism: removes a symlink pointing at our target, or a dangling one;
  leaves a real file, or a symlink pointing elsewhere, alone) and
  `runUninstall(dirs)`, scanning every conventional directory rather than
  stopping at the first, since `--bin-dir` can have put a link somewhere
  `install`'s own search would not have chosen.
- `cli/src/docker.ts`: `Docker.removeImage(repository, tag)` — `docker rmi`,
  the one base-image mutation the CLI did not yet have a seam for.
- `cli/src/commands/teardown.ts` + `cli/src/model/teardown.ts` +
  `cli/schema/teardown.schema.json`: `bardolier teardown [--images]
  [--force]`. In order: `down-all` (needs the config still in place to find
  every project), unlink, then remove the config directory. `--images`
  removes only the base images actually present. Confirms unless `--force`;
  refuses to guess under `--json` with no `--force` (`INVALID_ARGUMENT`) — the
  `delete`/`volumes rm` pattern. `binDirs` defaults to the real conventional
  directories but is an explicit parameter precisely so a test cannot reach
  the machine running it and unlink a real install.

**Non-goals:** no project data, ever — no root's contents, no named
service/cache volume, no `data/`/`home/` inside a project directory. No
`--yes-really` beyond the existing confirm/`--force` pair; nothing here is
more destructive than `down-all` plus `install` in reverse, so it does not
need a second gate. Base images stay opt-in (`--images`) rather than default,
since `bardolier build` remakes them from scratch and a plain `teardown`
should not cost a multi-gigabyte re-download the user did not ask for.

**Done-check:** `test/teardown.test.ts` — confirms unless `--force` and a
refusal touches nothing; `--json` with no `--force` is `INVALID_ARGUMENT`;
stops running projects like `down-all`; removes the config directory;
removes a link this checkout owns while leaving an unrelated file at the same
name alone; `--images` removes only the images present, and none without the
flag; never touches a project directory; degrades gracefully with no daemon.
`test/install.test.ts` covers `unlinkOne`/`runUninstall` directly. `cli-spec.md`
§6 documents the command; `test/contracts.test.ts`'s frozen command-surface
list is extended to include it.
