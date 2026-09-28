# Phase 12 — extra ports

**Goal:** Close both open entries in `docs/development/migration-guide-gaps.md` with one
mechanism: a named, per-project, archetype-independent port published from
the dev container, beyond the archetype's own `app_port`. Covers a mobile
client or second UI app that needs a project's own process directly (not just
the browser, which can proxy through the frontend dev server), and a
browser-reachable dev tool on `library`/`ios`/`android`, which otherwise
publish nothing at all.

**Deliverables:**
- `project.yml` gains `extra_ports`, keyed by a user-chosen name (not a
  catalogue key), each `{ container_port, host_port }` — `model/project.ts`,
  `project.schema.json`. `workspace.ts`'s `orderManifest` must actually write
  it (a whitelist function; a new manifest field is silently dropped if not
  added here — this bit the first pass of this phase).
- `cli/src/allocator.ts`: `allocateExtraPort` — same rule as
  `allocateAppPort`, search starts at the caller's `--container-port` since
  there is no catalogue band to inherit. `assignedPorts` scans `extra_ports`
  across every manifest too, so uniqueness (§5) holds.
- `cli/src/extraports.ts` (new): the read model — `attachedExtraPorts`,
  `describeExtraPort`, `extraPortUrl` (`http://localhost:<port>`, the
  `connection_hint` equivalent for a port with no protocol a catalogue named).
- `cli/src/commands/port.ts` (new): `port add|remove|list`, mirroring
  `service.ts`'s add/remove precondition (`PROJECT_RUNNING` while up) and
  write-then-render sequence — `requireStopped`/`persist`/`catalogueIfNeeded`
  exported from `service.ts` and reused rather than duplicated.
- `compose.ts`: dev container `ports:` gains extra ports, sorted by name,
  after `app_port` when present; published even when `app_port` is absent
  (the `library`/`ios`/`android` case).
- `up.ts` validates each extra port is still bindable, same as a service's;
  `delete.ts` reports them in `released_ports`; `status`/`up` report
  `extra_ports` in their JSON (additive, optional — following `app_port`'s
  own post-freeze precedent, not `services`' required-array one).
- New error codes `EXTRA_PORT_ATTACHED`/`EXTRA_PORT_NOT_ATTACHED`; new
  schemas `port-add`/`port-remove`/`port-list`; `status.schema.json` and
  `up.schema.json` gain `extra_ports`.
- App: `AttachedExtraPort`/`PortAddOutput`/`PortRemoveOutput`/
  `PortListOutput` in `BardolierModels.swift`; `BardolierProject.extraPorts`
  (optional, matching `appPort`/`appUrl`); two `BardolierErrorCode` constants.
- `cli-spec.md` §4.2, new §5.1, §6 (Ports), §7, §9; `CLAUDE.md`'s dev-container
  paragraph; `docs/migration-guide.md` Part 2 rewritten now that option B
  exists; both gaps in `docs/development/migration-guide-gaps.md` moved to Resolved.

**Non-goals:** no change to `app_port`'s own allocation or retrofit path; no
catalogue entry, image, or volume for an extra port — it is the project's own
process, not a sibling container; no `new --extra-ports` convenience flag
(declare after creation, like most services are).

**Done-check:** on a temp SSD: `port add` on a `library` project publishes a
port compose otherwise would not; `port add` on a `web` project publishes
alongside `app_port` without disturbing it; both are TCP-reachable from the
host after `up` and survive a restart on the same port; `EXTRA_PORT_ATTACHED`/
`EXTRA_PORT_NOT_ATTACHED`/`PROJECT_RUNNING`/`INVALID_ARGUMENT` error paths;
`port remove`/`delete` release the port for reuse. Land as
`test/phase12-done-check.sh` plus a section in `test/regression.sh`
(`LAST=12`); unit coverage in `test/phase12.test.ts`.
