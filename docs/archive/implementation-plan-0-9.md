# Implementation Plan — Container Project Manager (phases 0-9, COMPLETE)

**Historical. Not a spec, and not a place to add work.** Phases 0-9 shipped;
what they built is described by `../cli-spec.md` (authoritative for behaviour)
and `../app-spec.md`, and each phase's done-check lives on in `test/`. Later
work gets its own small scoped file under `docs/phases/` instead of an entry
here.

This plan is phased so each phase is a single `/goal` you hand to Claude Code.
Phases are ordered by dependency. **The CLI is built and frozen before the app.**
Two phases (5 and 7) require **manual action by you** at the Mac — creating the
Xcode project and wiring generated files into the target — because Claude in the
container cannot create or modify an Xcode project. Those steps are called out
explicitly with a ⚠️ MANUAL marker.

Each phase lists: goal, deliverables, and a done-check you can run from the
terminal before moving on. Do not start a phase until the previous done-check
passes.

---

## Phase 0 — Repo scaffold & contracts

**Goal:** Establish the repo, the two schema files, and the error-code list as
the frozen contract, with no behaviour yet.

Deliverables:
- Repo layout: `cli/` (the `cproj` implementation), `app/` (empty for now,
  populated in Phase 5), `docs/` (these specs), `test/`.
- `services.yml` default catalogue (postgres, redis, mongo) per `cli-spec.md` §4.1.
- `project.yml` schema documented + a JSON Schema (or typed model) for it.
- The `status` JSON schema (`cli-spec.md` §7) captured as a typed model/fixture.
- Error-code enum (`cli-spec.md` §2) defined in one place.
- Choose the CLI language/runtime (recommend: TypeScript on Node, since the base
  image already has Node; or Bun). Record the choice in `CLAUDE.md`.

Done-check: `cproj --help` lists all commands (stubs allowed); schema files parse;
error-code list exists in code.

---

## Phase 1 — Read-only core: config, doctor, status, list

**Goal:** Everything that inspects without mutating.

Deliverables:
- Config loading (`~/.config/cproj/config.yml` + env overrides), readable when
  the SSD is absent.
- `cproj doctor --json` — Docker up? SSD mounted? base images present? catalogue
  valid?
- `cproj status [--json]` and `cproj list [--json]` — reading manifests + Docker
  state, emitting the frozen schema. With no projects, returns empty arrays
  cleanly.
- `--json` plumbing + human output as separate renderers.

Done-check: on an empty SSD, `cproj status --json` returns valid JSON with empty
`projects`/`orphaned_volumes`; `cproj doctor --json` correctly reports SSD
mounted/absent as you plug/unplug.

---

## Phase 2 — Project lifecycle: new, up, down, delete, compose generation

**Goal:** Create and run projects (services come in Phase 3).

Deliverables:
- `cproj new <name> --archetype <a>` — dir, `project.yml`, seeded `.gitignore`,
  `.dockerignore`, `CLAUDE.md`, and a compose file with just the dev
  container (no services yet).
- Deterministic compose generation (`cli-spec.md` §9) — stable ordering.
- `cproj up/down/delete` with idempotency and `PROJECT_*` errors.
- Base-image build (`cproj build`) for at least the `web` archetype, with host
  UID/GID build args; dev container bind-mounts project dir → `/work`.

Done-check: `new` → `up` → shell in manually (`docker exec`) shows `/work`
mounted and owned by your user → `down` removes the container, data persists →
`delete` removes the dir. `status` reflects each transition.

---

## Phase 3 — Services & port allocation

**Goal:** Attach/detach services with stable, unique, host-exposed ports.

Deliverables:
- `services.yml` consumption; `service add/remove/list`.
- Port allocator (`cli-spec.md` §5): scan all manifests, pick within band, probe
  host, persist to manifest, release on remove/delete, validate at `up`.
- Compose regeneration includes services (image, named volume, published
  `host_port:container_port`, env interpolation).
- Both add and remove require the project stopped (`PROJECT_RUNNING`).

Done-check: add postgres to two projects → each gets a distinct host port in its
band → both `up` → connect from a host GUI to each on its port → restart one →
port unchanged → remove from one → volume orphaned, port released → the freed
port is reused by the next add.

---

## Phase 4 — Volumes, shell, close-all, eject

**Goal:** Complete the CLI surface; the whole lifecycle is terminal-drivable.

Deliverables:
- `cproj volumes orphaned` / `volumes rm` with sizes.
- `cproj shell <name> --json` returning container + exec argv (no terminal spawn
  in the CLI).
- `cproj down-all`, `cproj eject` with `lsof` holder detection and
  `EJECT_BLOCKED { holders }`.

Done-check: run the **full lifecycle script** end to end from the terminal
(new → add service → up → `shell --json` resolves → status shows ports → down →
remove service → orphan appears with size → reclaim → delete → eject blocked
while a shell is cd'd into the SSD, then clear after quitting it). **This is the
contract-freeze gate.** Do not proceed to the app until this passes.

---

## Phase 5 — ⚠️ MANUAL: create the Xcode project, then CLI client layer

**Goal:** Stand up the app target and the CLI-wrapping layer inside it.

⚠️ **MANUAL STEP (you, in Xcode) — do this before running the phase goal:**
1. In Xcode: File → New → Project → macOS → App. Name it (e.g. `CprojBar`),
   interface **SwiftUI**, language **Swift**. Save it into the repo's `app/`
   directory so it lives alongside the specs.
2. Set the app to be a menu-bar app: in the App struct you'll use `MenuBarExtra`
   (Claude will write this), and set **`LSUIElement` = YES** (Info tab →
   "Application is agent (UIElement)") so there's no dock icon/window.
3. Turn **App Sandbox OFF** (Signing & Capabilities) for v1 — the app shells out
   to `docker`/`cproj` and the sandbox would block it. (Revisit later if you want
   to distribute it; for a local tool this is fine.)
4. Confirm the project builds and runs (empty menu-bar item) before handing off.

**Then the phase goal (Claude, editing files in `app/`):**
- `CprojClient` (`app-spec.md` §4): process exec, `--json`, `Codable` models
  mirroring the frozen schemas, error-code mapping.
- Models for `status`, project, service, orphaned volume.
- A debug view or `#Preview` that dumps decoded `status` so you can verify
  decoding against real CLI output.

⚠️ **MANUAL — adding Claude-generated Swift files to the target:** Claude writes
`.swift` files into `app/CprojBar/…`. New files created outside Xcode are **not
automatically in the build**. After each phase that adds Swift files:
- In Xcode, right-click the group → **Add Files to "CprojBar"…** → select the new
  files → ensure **"Add to targets: CprojBar" is ticked** → Add. (Or drag them
  from Finder into the Project Navigator with the target checked.)
- If you use an Xcode version / setup with **synchronized folder groups**
  (Xcode 16+ file-system-synchronized groups), files added on disk appear
  automatically — verify the group is the synchronized type; if so you can skip
  manual adding but still confirm target membership.
- Build (⌘B) to confirm the new files compile and are in the target.

Done-check: the app launches as a menu-bar item, calls `cproj status --json`, and
your debug view shows correctly decoded projects/services/ports.

---

## Phase 6 — App: full menu, actions, new-project, services, reclaim

**Goal:** Wire every CLI command to UI.

Deliverables (all per `app-spec.md`):
- Menu structure §5; refresh-on-open; activity/disabled states.
- Start/Stop/Delete; New-project window §8; Services submenu §6 with host-port
  display + copy-connection.
- Reclaim disk view §9; icon states §11; Preferences §12 (writing SSD path +
  terminal + shell toggle to the CLI config).
- Error mapping §13.

⚠️ **MANUAL:** repeat the "Add Files to target" step for any new `.swift` files
each time this phase's goal generates them; ⌘B to confirm. Also add
`NSAppleEventsUsageDescription` (target → Info → "Privacy - AppleEvents Sending
Usage Description") — opening a shell drives Terminal/iTerm with Apple events,
and without the string macOS terminates the app instead of asking.

Note: this phase also grew the CLI, under §1's rule that a need of the app
becomes a command — `catalogue` (the Services submenu and New-project offer the
whole catalogue), `config get|set` (Preferences writes the SSD path and terminal
to the one config), and `dir` on `status`'s projects (Open folder in Finder).
All additive; the Phase 4 freeze holds.

Done-check: perform the entire lifecycle **from the menu bar** — create a
project, add a service, start (shell opens), inspect ports, stop, remove service,
reclaim the orphan, delete. Matches the Phase 4 terminal run.

---

## Phase 7 — Shell-open, eject flow, polish

**Goal:** The two flows that touch the host terminal and the SSD.

Deliverables:
- Shell-open via the configured terminal (`app-spec.md` §7); Start-auto-shell
  preference (default ON).
- Close-all & eject §10: call `cproj eject`, render `holders` on `EJECT_BLOCKED`,
  Retry, ejected icon state.
- Click-to-copy connection strings; empty/edge states; first-run message if
  `cproj` isn't on PATH.

⚠️ **MANUAL:** final "Add Files to target" pass if needed; ⌘B; then a full manual
soak: start a couple of projects, open shells, quit them, Close-all & eject with
Xcode open (expect the holder warning), quit Xcode, eject succeeds.

Done-check: from a cold start you can drive everything from the menu bar and
safely eject; with Xcode running, eject is correctly blocked and reported.

---

## Phase 8 — Archetype base images (iOS, Android)

**Goal:** Complete the mobile archetypes' base images and the archetype→image map.

Deliverables:
- `claude-ios` (Swift toolchain + swiftlint, edit/logic-test only) and
  `claude-and` (Android SDK + Gradle) base images; archetype→image map complete.
- CLAUDE.md boundary note verified: nothing in the container attempts
  `xcodebuild` or host-only build steps.

Done-check: an `ios` project's container has the Swift toolchain and its
CLAUDE.md correctly steers the agent away from host-only build steps; an
`android` project can run a Gradle build/test in-container.

---

## Phase 9 — The agent in the container, and the memory of what it did

**Goal:** Make the dev container somewhere an agent can actually work, and make a
project you return to explain itself.

Deliverables:
- **Claude Code in all three base images**, pinned and checksum-verified, at a
  system path — not under `$HOME`, which is a mounted volume.
- **A persistent per-project `$HOME`** (`cproj-<project>-home`), so a `down` no
  longer costs the login, the shell history and the dotfiles. Per project rather
  than shared, because Claude Code files sessions by working directory and every
  dev container works in `/work`.
- **Host credentials and git identity lent to the container** through Compose's
  bare-name environment form, so the file stays byte-identical everywhere and a
  commit made inside is attributed to the human.
- **§9's dev-server port, finally implemented** — allocated, persisted as
  `app_port`, published, and retrofitted onto projects that predate the field.
- **`.cproj/handoff.md`, written by `down`** before the containers go: the
  repository's state plus the agent's own account of the session, best-effort
  and never able to fail the stop.
- **Disabled menu items that say why** — a dimmed row and an absent row looked
  identical, which is how "Delete…" came to look unimplemented.

⚠️ **MANUAL:** the half that needs a real login — `claude login` in a shell
surviving a down/up, a handoff whose top section is Claude's own summary, and
the two-project check that each note describes its own project.
Done-check: `bash test/phase9-done-check.sh`.

---

## Notes on running this with `/goal`

- Hand Claude **one phase at a time**. Point it at `cli-spec.md` / `app-spec.md`
  for the phase's detail and at `CLAUDE.md` for principles + boundaries.
- Consider interrogating a phase's plan before implementing it — most useful on
  Phases 3 (ports) and 5 (the app boundary).
- After each CLI phase, the done-check is a terminal script — keep those as
  regression checks.
- Never let a phase mutate a running project's services (the CLI forbids it; the
  app relays the refusal).
- The Xcode manual steps (Phase 5, and file-adding in 5–7) are the only points
  where you leave the terminal — everything else Claude does in the container.
