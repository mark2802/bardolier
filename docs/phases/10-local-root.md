# Phase 10 — a local root (no SSD required)

**Goal:** Make `ssd_root` pointed at an ordinary directory on the internal disk
a supported, first-class mode — not an accident of `probeSsd` being a plain
`isDirectory` check — with `eject` and `doctor` giving honest answers instead
of SSD-shaped ones.

**Grounding.** The project lifecycle already doesn't require a removable
volume: `discoverProjects`/`requireProject` gate on `probeSsd(config).mounted`,
which is `isDirectory(config.ssd_root)` (`cli/src/projects.ts`) — true for any
directory. `new`/`up`/`down`/`service *`/`volumes *` never touch `ssd_volume`
or `SsdDevice`. Only two places assume the root sits on a diskutil-manageable
removable volume:

- `bandolier eject` (`cli/src/commands/ssd.ts`) unmounts whatever `ssd_volume`
  names. Nothing today stops that from being `/` or another non-removable
  mount — `ctx.device.eject()` would be asked to `diskutil eject` it.
- `bandolier doctor`'s `ssd` finding (`cli/src/commands/doctor.ts`) always frames
  the root in SSD terms ("Plug in the SSD") even when the root is a perfectly
  fine local directory that simply isn't under `ssd_volume`.

**Deliverables:**
- `SsdDevice` (`cli/src/device.ts`) gains `removable(mountPoint): Promise<boolean>`
  — a `diskutil info -plist` read of `Ejectable`/`Internal`, false on any probe
  failure (never throws; matches the existing "never force" posture). This is
  the one new host call, so it lives on the existing seam, not on `probeSsd`
  (which stays a pure fs check, per its own doc comment).
- `runEject` checks `ctx.device.removable(ssd.volume)` before `down-all` runs.
  False → a new `EJECT_NOT_APPLICABLE` error (added to `EXTENDED_ERROR_CODES`
  in `errors.ts`, additive) naming the root and pointing at `bandolier down-all`
  instead. No containers get touched on the way to that refusal.
- `doctor`'s `ssd` finding: once `mounted` is true, branch on `removable`.
  Removable → today's wording unchanged. Not removable → `ok: true`, detail
  explains the root is on the internal disk and `eject` doesn't apply, no
  "plug in" remedy. `id` stays `ssd` (frozen enum in `doctor.schema.json`);
  only `title`/`detail` text changes, which the schema leaves free.
- `cli-spec.md` §6 (eject bullet) and §2 (error list) gain the new code; §8
  (Configuration) gains a line stating `ssd_root` may be any local directory
  and `eject` is simply unavailable when it isn't backed by a removable
  volume.
- App: `BandolierModels.swift`'s error-code decoding already tolerates an unknown
  code as an open token, but the eject menu row / `EjectPanel` should treat
  `EJECT_NOT_APPLICABLE` like a missing archetype Dockerfile — hidden via
  `disabledReason`, not surfaced as a failure banner.

**Non-goals:** no config rename (`ssd_root`/`ssd_volume` keep their names —
the churn a rename costs isn't earned by this); no change to how
`new`/`up`/`down`/services work, since they already don't care where the root
lives.

**Done-check:** point `BANDOLIER_SSD_ROOT` at a plain temp dir on the internal
disk, `BANDOLIER_SSD_VOLUME` left at its default (so `removable` resolves false) —
run the full lifecycle (`new` → `up` → `service add` → `status` → `down` →
`delete`) and confirm every step behaves exactly as it does on the SSD;
`bandolier doctor --json` reports the root `ok: true` with no "plug in" remedy;
`bandolier eject --json` fails `EJECT_NOT_APPLICABLE` immediately, containers
untouched. Land this as `test/phase10-done-check.sh` and a section in
`test/regression.sh`.
