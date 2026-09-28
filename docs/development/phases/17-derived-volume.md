# Phase 17 — one root, a derived volume

**Goal:** Stop asking the user where the SSD is mounted. `ssd_volume` becomes
a value derived from `ssd_root` rather than a second preference that can
disagree with it — collapsing two fields to one and deleting the whole class of
misconfiguration `config.ts` currently apologises for defending against.

**Grounding.** `ssd_volume` is what `eject` unmounts; `ssd_root` is the
directory holding project dirs. They are genuinely different things (you cannot
`diskutil eject` a subdirectory), which is why `config.ts` defaults the root
*inside* the volume "so the two can never point at different disks" — a
defence that exists only because both are settable. The volume is discoverable
from the root: on macOS a mount boundary is a change of `st_dev`, so walking
from the root up to the last ancestor sharing its device number IS the mount
point. This is also a prerequisite for phase 18 — with several roots there
cannot be one configured `ssd_volume`.

**Deliverables:**
- `cli/src/projects.ts`: `containingVolume(path): string | null` — the
  `st_dev` walk. It lives here, not on `SsdDevice`, because it is pure `stat`
  with no spawn: that is what lets `probeSsd` keep the promise in its own doc
  comment (read-only, never throws, safe with the disk absent) while reporting
  a volume it no longer gets from config. `null` when the root is not readable.
  `SsdDevice.removable()` — already on the seam since phase 10 — remains the
  thing that decides whether that volume can be ejected.
- `SsdProbe`: `volume` is now derived; **`volumePresent` is deleted**. With the
  volume derived from the root there are only two states worth distinguishing —
  the root is readable and we know its volume, or it is not and there is
  nothing to name. `doctor`'s remedy loses its `volumePresent` branch and names
  the root ("… is not readable; plug in the disk that holds it, or point
  `ssd_root` somewhere else"), which is the actionable half of what the old
  two-branch message said anyway.
- `runEject`: resolve the volume from the root before anything else. Root
  unreadable → `SSD_NOT_MOUNTED` naming the root. Volume resolved but not
  `removable()` → `EJECT_NOT_APPLICABLE`, unchanged in code and meaning, now
  naming a derived path. `EjectOutput.volume` already carries the answer to the
  app, so nothing downstream needs to compose it.
- Config: `ssd_volume` leaves `Config`, `ConfigFile`, `CONFIG_KEYS`,
  `config.schema.json`, `EffectiveConfig`, and the `$BDLR_SSD_VOLUME`
  override. `DEFAULT_SSD_VOLUME` goes with it; the default `ssd_root` becomes
  the literal `/Volumes/ssd/claude-projects` for now — phase 18 is where the
  default stops assuming a disk exists.
- **This removes a key from a frozen contract.** §5's additive-only rule is
  deliberately spent here: pre-publish is the one window in which it is free,
  and it is spent again in phase 18. Both belong to the same break.
- App: `PreferencesPanel` loses the Volume field and its caption, and the SSD
  section becomes one labelled path. `ConfigKey.ssdVolume` and
  `EffectiveConfig.ssdVolume` leave `BardolierModels.swift`;
  `test/app-models.test.ts` holds the removal in both directions.
- `cli-spec.md` §8 (the key list and the "defaults inside" rule, both gone),
  §6's eject bullet; `CLAUDE.md`'s eject and Context paragraphs.

**Non-goals:** no multi-root (phase 18); `probeSsd` stays a pure filesystem
check that spawns nothing; no change to `status`'s shape — `ssd: { mounted,
root }` already omits the volume, which is the evidence that nothing outside
`eject` and `doctor` ever needed it.

**Done-check:** with the root on the internal disk, `eject --json` fails
`EJECT_NOT_APPLICABLE` naming the derived volume and touches no container; with
the root on a removable volume (or a stubbed `removable()`), the volume in
`EjectOutput` is the one derived from the root and not anything config said;
with the root absent, `SSD_NOT_MOUNTED` names the root; a root *nested several
directories deep* inside its volume still resolves to the mount point;
`config get --json` has no `ssd_volume`; `$BDLR_SSD_VOLUME` set is ignored and
absent from `overrides`. Land as `test/phase17-done-check.sh` plus a section in
`test/regression.sh` (`LAST=17`); unit coverage in `test/phase17.test.ts`.
