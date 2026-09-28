# Phase 22 — eject --all, and the menu's own notices

**Goal:** Three app-reported rough edges, fixed at whichever layer they
actually belong to.

**Deliverables:**
- `bardolier eject --all` (CLI): every mounted, removable root, best-effort.
  `down-all` once, then each candidate unmounted independently — one disk still
  held must not cost the user an eject on a second, clean one. New
  `EjectAllOutput`/`EjectAllResult` (`model/ssd.ts`), `eject-all.schema.json`,
  mutually exclusive with `[<root>]` (`INVALID_ARGUMENT`). `cli-spec.md` §6.
- `EjectPanel` (app): the root picker offers only roots `doctor` reports
  `removable: true` for — a plain internal-disk root was never a valid eject
  target and must not appear as if it were one — plus an **All roots** choice
  when more than one qualifies, driving `eject --all`. A new `ejectPhase` case
  renders `EjectAllOutput`'s per-root results (some ejected, some still held)
  in one panel rather than picking one to show.
- `BardolierStore.notice` (app): self-dismisses a few seconds after being set,
  instead of sitting until the user finds the small `×` or starts another
  action. `lastError` and `shellDowngrade` are unaffected — a state the user
  must act on stays until they do. The dismiss buttons on all three banners
  get a larger hit target while here, since a `9pt` icon with no padding was
  the other half of "hard to dismiss".

**Non-goals:** no change to the single-root `eject` semantics or its
error codes; no forcing anywhere in `--all` that the single-root path
wouldn't also refuse.

**Done-check:** `test/eject.test.ts` — `runEjectAll` with zero removable roots
(`EJECT_NOT_APPLICABLE`), with every candidate clean (`EjectAllOutput`
validates), and with one candidate blocked while a second still ejects
(best-effort, nothing forced). `test/roots-done-check.sh` — `eject --all`
against two non-removable roots is `EJECT_NOT_APPLICABLE`. The Swift changes
have no automated check (no Xcode in-container); reviewed by hand against
`app-spec.md` §10 and built by the human.
