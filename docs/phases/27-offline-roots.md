# Phase 27 — offline roots

**Goal:** every command works with any configured root unplugged, using what
bardolier learned the last time that root was readable, and says when it did.

**Grounding.** Phase 18 made `ROOT_UNREADABLE` refuse a partial view for port
allocation and the orphan scan — correct, and "the single most dangerous edge
in the phase". But it made a second root a liability: cloning a project that
lives entirely on the internal disk, into the internal disk, failed because an
external SSD happened to be unplugged. `INTENT.md`'s purpose is a project you
can "create, hand to an agent, stop, and unplug" — that should include the
*other* root, unplugged, while you keep working.

Two facts are genuinely global and cannot be derived from the readable roots:
port uniqueness (§5) and project-name uniqueness (§6, invariant 3 — two roots
sharing a name share a container name and a home volume). `requireFreeName`
already only checked readable roots and did not refuse a partial view; it was
masked because the allocator refused first. Fixing the allocator without
fixing this would have turned a latent bug into a routine one, so this phase
does both.

**INTENT.md decision** (added before this phase, by the owner): *"Cross-root
knowledge while a root is offline | a derived index on the internal disk,
rebuilt from the manifests, never authoritative | 2026-09-07"* — bounding the
exception to "one `project.yml`; no second registry".

**Deliverables:**
- **The root index** — `model/rootindex.ts` (types), `rootindex.ts` (logic).
  One JSON file per root, keyed by path, holding each project's name,
  archetype, base image and every host port it holds. Three rules keep it
  from becoming a second registry (module header): one file per root in a
  shape `workspace.ts` cannot parse; it answers exactly the name/port/cache
  questions and nothing reads it to act on a project; it is consulted only
  for a root discovery cannot reach.
- **Kept fresh two ways, neither a poll.** WRITE-THROUGH:
  `workspace.ts:writeManifest` folds every manifest write into its root's
  index (covers `new`, `clone`, `service add|remove`, `port add|remove`,
  `deps add|remove`, `up`'s `app_port` retrofit); `delete`/`move` update it
  directly for what they don't route through `writeManifest`. RECONCILE:
  `status`, `doctor` and `eject` already walk every readable root, so
  `reconcileReadableRoots` rewrites each one's index from that same walk —
  free, and what catches drift bardolier did not cause (a hand-edited
  `project.yml`, a drive used on another Mac).
- **`allocator.ts`** — `assignedPorts` takes a `Context`, not a `Config`; an
  unreadable root folds in its index instead of throwing. Never indexed:
  contributes nothing, allocation proceeds. The cost of being wrong is a loud
  `PORT_UNAVAILABLE` at the next `up`, never data loss.
- **`commands/new.ts:requireFreeName`** — the one place phase 27 stays strict.
  A name collision is invariant 3, not invariant 4, so an unreadable root
  with no index is still `ROOT_UNREADABLE` ("plug it in once — after that,
  this works with it offline too"); one with an index is checked against it
  like a readable root.
- **`volumes.ts`** — the named-volume half needs every root's claims; the
  directory half never did (unaffected). An unreadable root folds in its
  index's cache claims; one with no index omits named-volume orphans
  entirely (nothing unverifiable reaches `volumes rm`) and names itself in
  `unverified_roots`. `ROOT_UNREADABLE` is gone from this path; `SSD_NOT_MOUNTED`
  (no root readable at all) is unchanged.
- **`commands/doctor.ts`** — reconciles every readable root (free); a new
  `ports` finding reports a port or name held by two roots at once — the
  `doctor` finding §5 already promised ("a collision between two previously
  separate roots is a finding, not a silent repair") but never implemented.
  `ok: true`, skipped, unless every configured root answered live.
- **Reporting.** `status.roots[].last_indexed` (null while mounted or never
  indexed). `NewOutput`/`CloneOutput`/`ServiceAddOutput`/`PortAddOutput` gain
  `degraded_roots?: { root, path, last_indexed }[]`, non-empty only when this
  call allocated against an offline root's index. `VolumesOrphanedOutput`
  gains `unverified_roots?: string[]`. All additive; schemas and
  `test/contracts.test.ts` bind the shared `$defs/offline_root` block across
  new/clone/service-add/port-add, same discipline as `attached_service`.
- **The app** — `ConfiguredRoot.lastIndexed`, `OfflineRoot`, and the four
  outputs' `degradedRoots`/`unverifiedRoots`, mirrored in
  `BardolierModels.swift`. `PreferencesPanel` shows "not readable — last seen
  …" instead of a bare "not readable". `BardolierError.rootUnreadable` gains a
  `recoverySuggestion` naming the root from `details.roots`, which the error
  carried all along but the app dropped. No new Swift files.

**Non-goals:** no polling, no `NSWorkspace` mount watcher — considered and cut
(`rootindex.ts` header); every path here keys off write-through or a scan a
command was already doing. No change to port bands or density (§5.4). No
re-allocation when a root reappears — an existing cross-root collision is
still `doctor`'s `ports` finding to report, never bardolier's to repair. No
mirroring of `project.yml` itself — the index is a four-field projection,
never the manifest.

**Done-check** — `test/roots-done-check.sh` §13–14, `test/ports.test.ts`
("an offline root degrades allocation rather than refusing it"),
`test/contracts.test.ts` (`offline-root contracts`), `test/app-models.test.ts`:

- with an unreadable root that HAS been indexed: `service add` on another root
  succeeds without handing out a port it holds, naming it in `degraded_roots`;
  `volumes orphaned` succeeds with no `unverified_roots`; `status` still
  succeeds, lists only the readable root's projects, and dates the offline
  one's index;
- with an unreadable root that has NEVER been indexed: `new`/`clone` still
  refuse `ROOT_UNREADABLE` on a name collision — the strict case — but a port
  allocation elsewhere proceeds; `volumes orphaned` succeeds, omitting
  named-volume orphans and naming the root in `unverified_roots`;
- write-through alone, with no `status`/`doctor` call in between: a port
  assigned by `new` in one root is respected by an allocation in another the
  moment the first root goes offline;
- `doctor`'s `ports` finding is `ok: true` with nothing colliding, and reports
  a hand-planted duplicate name or port across two roots when both are readable.
