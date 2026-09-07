//
//  BardolierStore.swift
//  Bardolier
//
//  What the menu bar is currently looking at, and the one place an action runs.
//
//  The store holds NO truth of its own: it holds the last answer the CLI gave
//  and the fact that a call is in flight. Nothing here computes a project's
//  state, a port, or whether a volume is reclaimable — those are answers, and
//  answers come from `bardolier` (CLAUDE.md, app-spec.md §4).
//
//  Phase 6 turns it from a reader into the app's action surface, under three
//  rules that keep a thin client thin:
//
//  1. ONE OPERATION AT A TIME. `activity` names what is running; while it is
//     set, every mutating menu item is disabled (§4, "conflicting actions
//     disabled until completion"). The CLI's own state machine assumes nobody
//     is rewiring a project while it starts.
//  2. EVERY MUTATION IS FOLLOWED BY A REFRESH (§4). The store never patches its
//     own copy of `status` to reflect what it thinks a command did — it asks.
//  3. A REFUSAL IS RELAYED, NEVER WORKED AROUND. PROJECT_RUNNING from a service
//     change becomes "Stop the project to change its services" (§6, §13); it
//     does not become a stop-change-start sequence the user didn't ask for.
//
//  Confirmation for destructive actions happens in the VIEW, before the call —
//  `BardolierClient` passes `--force`, because the CLI cannot prompt with no
//  terminal (app-spec.md §6, §9).
//
//  Phase 7 adds the two states that outlive a command: `ejectPhase`, because a
//  blocked eject is something the user goes away and fixes before retrying
//  (§10), and `bardolierMissing`, because an app that cannot find its CLI has
//  nothing to say about anything else and should say THAT once (§13).
//

// Combine is imported directly, not by way of SwiftUI: the target builds with
// MemberImportVisibility, under which a transitively-imported module's members
// are not visible — and ObservableObject's synthesized `objectWillChange` is
// one of Combine's.
import Combine
import Foundation
import SwiftUI

/// Where Close all & eject has got to (app-spec.md §10).
///
/// A phase rather than a plain error, because §10 describes a flow with a
/// shape: stop everything, ask who still holds the disk, unmount. "Something
/// still holds it" is not a failure to dismiss — it is a state the user acts on
/// (quit Xcode) and then RETRIES, and the holder list has to survive on screen
/// long enough for them to do that. Reducing it to `lastError` would put it in
/// a banner that the next refresh's success wipes.
nonisolated enum EjectPhase: Equatable, Sendable {
    /// Nothing attempted yet, or the SSD came back.
    case ready
    /// `bardolier eject` is running: down-all, then the holder check, then diskutil.
    case working
    /// EJECT_BLOCKED. `holders` is the CLI's answer, rendered verbatim; the app
    /// never forces and offers Retry instead (§10).
    case blocked(holders: [SsdHolder], message: String)
    /// EJECT_BLOCKED because Docker Desktop's VM still holds the volume — kept
    /// apart from `blocked` because the user's move is different. There is
    /// nothing to quit and no retry that works: the disk goes when the ENGINE
    /// stops, so the panel offers that instead of "quit them, then Retry".
    ///
    /// `engineStopped` is the same refusal arriving AFTER that offer was taken:
    /// the CLI stopped the engine, waited for the VM to let go, and the disk
    /// still would not unmount. The move changes again — there is no engine
    /// left to stop — so the panel renders the CLI's own sentence and offers
    /// only Retry, rather than a button that would repeat what just happened.
    case blockedByDocker(holders: [SsdHolder], message: String, engineStopped: Bool)
    /// Unmounted. The "safe to unplug" state (§10, §11).
    case ejected(volume: String, stopped: [String])
    /// `eject --all` returned (phase 22) — never a thrown failure for a
    /// blocked disk, so this is what BOTH a clean sweep and a mixed one land
    /// in: `results` names each root, `ejected` per-root telling the two
    /// apart in one panel rather than picking one to show.
    case ejectedAll(results: [EjectAllResult], stopped: [String])
    /// EJECT_NOT_APPLICABLE (phase 10): the root's path is a plain directory on the
    /// internal disk, not a removable volume. Kept apart from `failed` because
    /// it isn't one — nothing is wrong, there is simply nothing to eject, so the
    /// row goes quiet with a reason instead of a Retry that would fail the same
    /// way forever (the same treatment as a missing archetype Dockerfile).
    case notApplicable(message: String)
    /// Something else went wrong — the SSD already gone, Docker refusing.
    case failed(message: String)

    var isBlocked: Bool {
        switch self {
        case .blocked, .blockedByDocker: return true
        case .ejectedAll(let results, _): return results.contains { !$0.ejected }
        default: return false
        }
    }
    var isEjected: Bool {
        switch self {
        case .ejected: return true
        case .ejectedAll(let results, _): return results.allSatisfy { $0.ejected }
        default: return false
        }
    }
}

/// The menu bar icon (§11, app-spec.md). ONE base glyph at every state —
/// `shippingbox` — so the icon reads as the same app across the whole state
/// machine. A previous version swapped in a wholly different pictogram per
/// state (`eject.circle`, `externaldrive.badge.exclamationmark`), which is
/// exactly what made the menu bar look like a different app from one moment
/// to the next; state is now a small corner badge and a pulse on the SAME
/// glyph, never a different one.
nonisolated struct MenuBarIcon: Equatable {
    /// Outline before the first status answer, filled once there is one —
    /// the one difference that predates any state beyond "loading".
    let filled: Bool
    /// A small corner badge — nil when nothing needs flagging.
    let badge: Badge?
    /// A subtle pulse on the same glyph while an operation runs (§4) —
    /// motion says "busy", not a shape swap.
    let animated: Bool

    nonisolated enum Badge: Equatable {
        /// Degraded: the SSD is absent, or Docker isn't available.
        case warning
        /// Ejected: safe to unplug.
        case done
    }
}

@MainActor
final class BardolierStore: ObservableObject {
    /// The last `bardolier status --json`, or nil before the first successful call.
    @Published private(set) var status: BardolierStatus?
    /// The last `bardolier doctor --json` — the launch check (app-spec.md §4).
    @Published private(set) var doctor: DoctorOutput?
    /// Every service the catalogue defines (§6, §8). Loaded once, on demand.
    @Published private(set) var catalogue: CatalogueOutput?
    /// The effective CLI config — what Preferences edits (§12).
    @Published private(set) var cliConfig: ConfigGetOutput?
    /// The most recent failure, already reduced to a human sentence (§13).
    @Published private(set) var lastError: BardolierFailure?
    /// The result of the last action worth reporting — an assigned host port,
    /// a kept volume, reclaimed bytes (§6, §9). Self-dismisses a few seconds
    /// after being set: a success is a receipt, not something the user must
    /// act on, and the small `×` was too fiddly a way to have to say "seen it".
    @Published private(set) var notice: String? {
        didSet {
            noticeDismissTask?.cancel()
            guard notice != nil else { return }
            noticeDismissTask = Task { [weak self] in
                try? await Task.sleep(nanoseconds: 5_000_000_000)
                guard !Task.isCancelled else { return }
                self?.notice = nil
            }
        }
    }
    /// Why the last shell had to open by the lesser route (§7). Kept out of
    /// `notice` because it self-dismisses (above) and a downgrade is a state
    /// the user has to act on to actually fix (installing the terminal
    /// bardolier prefers), not a receipt that is fine to have flashed past.
    @Published private(set) var shellDowngrade: String?
    /// What is running right now, or nil when idle. Drives the activity icon
    /// (§11) and disables conflicting actions (§4).
    @Published private(set) var activity: String?
    /// Where `bardolier` was found, for Preferences and the first-run message.
    @Published private(set) var executablePath: String?
    /// When the current `status` was taken.
    @Published private(set) var lastRefresh: Date?
    /// Set by a successful eject and cleared the moment the SSD is seen
    /// mounted again — the "safe to unplug" icon state (§10, §11).
    @Published private(set) var ejected = false
    /// Where Close all & eject has got to (§10). Survives a refresh so the
    /// holder list is still there when the user comes back from quitting Xcode.
    @Published private(set) var ejectPhase: EjectPhase = .ready
    /// True when `bardolier` could not be found at all — the first-run state (§13).
    /// Nothing the menu offers can work until it is false, so the menu says so
    /// instead of failing one command at a time.
    @Published private(set) var bardolierMissing = false
    /// Everywhere `bardolier` was looked for, in order — shown by the first-run
    /// message so what the user is told matches what was actually tried (§13).
    @Published private(set) var bardolierSearchedLocations: [String] = []

    private let client: BardolierClient
    private var refreshTask: Task<Void, Never>?
    /// Cancelled and replaced every time `notice` is set — the auto-dismiss
    /// below — so a fast second notice doesn't get wiped early by the first
    /// one's timer, and no timer outlives the notice it was set for.
    private var noticeDismissTask: Task<Void, Never>?

    /// §4 asks for a refresh on every menu open; reopening the menu twice in a
    /// second shouldn't queue two subprocesses behind each other.
    private let minimumInterval: TimeInterval = 0.5

    init(client: BardolierClient = BardolierClient()) {
        self.client = client
    }

    // MARK: - Derived state (all of it from the last status/doctor, §11)

    var isBusy: Bool { activity != nil }

    /// Icon state, derived purely from the latest status/doctor (§11). Busy
    /// wins over everything else — while a command is running, that is the
    /// one thing worth the icon saying.
    var menuBarIcon: MenuBarIcon {
        if isBusy { return MenuBarIcon(filled: true, badge: nil, animated: true) }
        if ejected { return MenuBarIcon(filled: true, badge: .done, animated: false) }
        guard let status else { return MenuBarIcon(filled: false, badge: nil, animated: false) }
        if !status.ssd.mounted || !status.docker.available {
            return MenuBarIcon(filled: true, badge: .warning, animated: false)
        }
        return MenuBarIcon(filled: true, badge: nil, animated: false)
    }

    /// True when the environment can't do the thing the menu is offering —
    /// every mutating item is disabled and says why.
    var isDegraded: Bool {
        guard let status else { return true }
        return !status.ssd.mounted || !status.docker.available
    }

    /// One line for the top of the menu (§5's status line). Speaks of "SSD"
    /// only when the default root is known to be a removable volume (phase
    /// 18) — an internal-disk root is a folder, not a drive to plug in, and
    /// while it's unmounted there is nothing for `diskutil` to answer, so an
    /// unknown kind reads as "root", never a guessed "SSD".
    ///
    /// Not mounted with `defaultRootRemovable == true` is the one case
    /// `doctor` can't currently confirm (its check needs the volume present)
    /// — that value can only be true here because a PRIOR `doctor` saw it
    /// removable, i.e. the CLI's last real answer, not an app-side guess.
    var ssdSummary: String {
        guard let status else { return "SSD: checking…" }
        if ejected && !status.ssd.mounted { return "SSD: ejected — safe to unplug" }
        if !status.ssd.mounted {
            return defaultRootRemovable == true ? "SSD: not mounted (\(status.ssd.root))" : "Root not found: \(status.ssd.root)"
        }
        return defaultRootRemovable == false ? "Root: \(status.ssd.root)" : "SSD: mounted (\(status.ssd.root))"
    }

    /// Why the mutating items are disabled, or nil when they aren't.
    var degradedReason: String? {
        guard let status else { return nil }
        if !status.ssd.mounted {
            guard defaultRootRemovable == true else { return "Create the projects folder, or set its path in Preferences." }
            return ejected ? "Plug the SSD back in to carry on." : "Plug the SSD in, or set its path in Preferences."
        }
        if !status.docker.available { return "Start Docker Desktop to run projects." }
        return nil
    }

    var projects: [BardolierProject] { status?.projects ?? [] }
    var orphanedVolumes: [OrphanedVolume] { status?.orphanedVolumes ?? [] }

    func project(named name: String) -> BardolierProject? {
        projects.first { $0.name == name }
    }

    /// The terminal the CLI config names — the single source for it (§8, §12).
    var terminalName: String { cliConfig?.config.terminal ?? BardolierTerminal.fallbackName }

    // MARK: - Reading

    /// What every menu open does (app-spec.md §4): the first one runs the
    /// launch checks, every later one just refreshes — debounced.
    func appear() async {
        if doctor == nil {
            await start()
        } else {
            await refresh()
        }
    }

    /// Launch sequence: run `doctor`, read the config, then take a first status.
    func start() async {
        await loadDoctor()
        await loadConfig()
        await refresh(force: true)
    }

    /// Refresh `status`. Coalesces: a call already in flight is awaited rather
    /// than duplicated, and a refresh within `minimumInterval` of the last one
    /// is skipped unless forced (§4, debounce).
    func refresh(force: Bool = false) async {
        if let refreshTask {
            await refreshTask.value
            return
        }
        if !force, let lastRefresh, Date().timeIntervalSince(lastRefresh) < minimumInterval {
            return
        }

        let task = Task { [client] in
            // Only a bare refresh shows as activity; a refresh that follows an
            // action keeps that action's label so the menu doesn't flicker.
            let owned = activity == nil
            if owned { activity = "Refreshing" }
            defer { if owned { activity = nil } }

            // Re-resolved every time, like the client does: installing `bardolier`
            // or setting the preference then fixes a first-run failure on the
            // next menu open rather than on the next launch.
            do {
                executablePath = try BardolierExecutable.resolve().path
                bardolierMissing = false
            } catch {
                // Not `lastError`: a missing binary is not a failed command,
                // it is the app having nothing to talk to (§13). The menu
                // renders the first-run message instead of a banner.
                executablePath = nil
                bardolierMissing = true
                bardolierSearchedLocations = BardolierExecutable.searchedLocations
            }
            do {
                let wasMounted = status?.ssd.mounted ?? true
                let fresh = try await client.status()
                status = fresh
                // The SSD coming back is the only thing that clears "ejected";
                // deriving it from status is what keeps §11 honest when the
                // user replugs the disk without touching the menu.
                if fresh.ssd.mounted {
                    ejected = false
                    // Only the "safe to unplug" state is retired by the disk
                    // coming back. A BLOCKED eject must survive this: the disk
                    // still being mounted is precisely what blocked means, so
                    // clearing on `mounted` would wipe the holder list on the
                    // very next menu open — the one after the user went off to
                    // quit Xcode (§10).
                    if ejectPhase.isEjected { ejectPhase = .ready }
                    // A root mounting for the first time this session is the
                    // one moment `doctorRoots` can be stale in the direction
                    // that matters — `defaultRootRemovable` still nil from a
                    // launch that saw it absent — so `ssdSummary` would call a
                    // real SSD a bare "root". `doctor` re-derives it now that
                    // there's something for `diskutil` to answer.
                    if !wasMounted { await loadDoctor() }
                }
                lastRefresh = Date()
                lastError = nil
            } catch let failure as BardolierFailure {
                lastError = failure
            } catch {
                lastError = .unexpectedFailure(exitCode: -1, stdout: "", stderr: String(describing: error))
            }
        }
        refreshTask = task
        await task.value
        refreshTask = nil
    }

    /// `doctor` never fails on a failing check — it reports one — so a thrown
    /// error here means the CLI itself couldn't be run.
    func loadDoctor() async {
        do {
            doctor = try await client.doctor()
        } catch let failure as BardolierFailure {
            lastError = failure
        } catch {
            lastError = .unexpectedFailure(exitCode: -1, stdout: "", stderr: String(describing: error))
        }
    }

    /// The catalogue (§6, §8). Cached: `services.yml` is a file the user edits
    /// by hand, not something that changes under the menu, so one read per
    /// launch is enough — Preferences can force a re-read.
    func loadCatalogue(force: Bool = false) async {
        if catalogue != nil && !force { return }
        do {
            catalogue = try await client.catalogue()
        } catch let failure as BardolierFailure {
            // A broken catalogue must not take the menu down with it: the
            // Services submenu says it can't list services and everything else
            // keeps working.
            lastError = failure
        } catch {
            lastError = .unexpectedFailure(exitCode: -1, stdout: "", stderr: String(describing: error))
        }
    }

    /// Project names, for the New-project window's collision check (§8). Uses
    /// `list` rather than the cached `status`, because the check should be
    /// against what is on the disk NOW, not against whatever the menu last saw.
    func projectNames() async -> [String] {
        do {
            return try await client.list().projects.map(\.name)
        } catch let failure as BardolierFailure {
            // A failure here is not worth blocking creation over: the CLI
            // checks for a collision itself and answers PROJECT_EXISTS.
            lastError = failure
            return projects.map(\.name)
        } catch {
            return projects.map(\.name)
        }
    }

    func loadConfig() async {
        do {
            cliConfig = try await client.configGet()
        } catch let failure as BardolierFailure {
            lastError = failure
        } catch {
            lastError = .unexpectedFailure(exitCode: -1, stdout: "", stderr: String(describing: error))
        }
    }

    // MARK: - Actions (app-spec.md §5, §6, §9, §10)

    /// Start a project, and — per the preference, default ON — drop the user
    /// into a shell (§7). `up` reports `open_shell`; the CLI never spawns a
    /// terminal, so the cue comes back and the app acts on it.
    func start(project name: String, openShell: Bool) async {
        let result = await perform("Starting \(name)") { client in
            try await client.up(project: name, openShell: openShell)
        }
        guard let result else { return }
        notice = result.alreadyRunning ? "\(name) was already running." : "\(name) is up."
        if result.openShell {
            // `self.` because the parameter of the same name shadows it.
            await self.openShell(project: name)
        }
    }

    func stop(project name: String) async {
        let result = await perform("Stopping \(name)") { client in
            try await client.down(project: name)
        }
        guard let result else { return }
        notice = result.wasRunning ? "\(name) stopped. Its data is untouched." : "\(name) was already stopped."
    }

    /// CONFIRM FIRST — the client passes `--force` (§9). The project's data
    /// lives inside its directory (phase 19), so a plain delete refuses
    /// PROJECT_HAS_DATA once there is any; `purge` is what destroys it.
    func delete(project name: String, purge: Bool) async {
        let result = await perform("Deleting \(name)") { client in
            try await client.delete(project: name, purge: purge)
        }
        guard let result, result.deleted else { return }
        notice = "Deleted \(name)."
    }

    /// Attach a service. A running project fails PROJECT_RUNNING and the
    /// refusal is what the user sees — the app does not stop the project for
    /// them (§6).
    func attach(service key: String, to name: String) async {
        let result = await perform("Attaching \(key) to \(name)") { client in
            try await client.serviceAdd(project: name, service: key)
        }
        guard let result else { return }
        // §6: after any change, show the newly assigned host port.
        notice = "\(result.added.display) attached on host port \(result.added.hostPort) — \(result.added.connectionHint)"
    }

    /// Detach a service. The data directory is KEPT and becomes a listed
    /// orphan of the project (§6).
    func detach(service key: String, from name: String) async {
        let result = await perform("Detaching \(key) from \(name)") { client in
            try await client.serviceRemove(project: name, service: key)
        }
        guard let result else { return }
        let kept = " Its data in \(result.removed.dataDir) is kept — reclaim it from Reclaim disk."
        notice = "Detached \(result.removed.key); host port \(result.removed.hostPort) released.\(kept)"
    }

    /// Create a project (§8). Returns the payload so the window can close only
    /// on success, and reports the ports any initial services were assigned.
    @discardableResult
    /// `root` picks which configured root to create it under (phase 18);
    /// `nil` defers to the CLI's own default (the first configured root).
    func create(name: String, archetype: Archetype, services: [String], root: String? = nil) async -> NewOutput? {
        let result = await perform("Creating \(name)") { client in
            try await client.new(name: name, archetype: archetype, services: services, root: root)
        }
        guard let result else { return nil }
        let ports = result.services.map { "\($0.key) :\($0.hostPort)" }.joined(separator: ", ")
        notice = ports.isEmpty ? "Created \(name)." : "Created \(name) — \(ports)."
        return result
    }

    /// Open a shell in the configured terminal (§7). The CLI names the command;
    /// the app is what runs it.
    ///
    /// Both halves can fail differently and are reported differently: `bardolier
    /// shell` refusing (the project is stopped) is a CLI failure, while the
    /// terminal refusing is a Preferences problem and says so.
    func openShell(project name: String, root: Bool = false) async {
        do {
            let invocation = try await client.shell(project: name, root: root)
            // A note comes back when the shell opened by a lesser route — say
            // so, rather than letting a silent downgrade look like normal.
            if let note = try BardolierTerminal.open(invocation, in: terminalName) {
                shellDowngrade = note
            } else {
                // The good route worked, so whatever the banner still claims
                // about a downgrade has stopped being true.
                shellDowngrade = nil
            }
        } catch let failure as BardolierFailure {
            lastError = failure
        } catch let failure as TerminalFailure {
            lastError = .terminalFailed(terminal: terminalName, underlying: failure.message)
        } catch {
            lastError = .unexpectedFailure(exitCode: -1, stdout: "", stderr: String(describing: error))
        }
    }

    /// CONFIRM FIRST — destroys the volume's data (§9).
    func reclaim(volume name: String) async {
        let result = await perform("Removing \(name)") { client in
            try await client.removeVolume(name: name)
        }
        guard let result, result.removed else { return }
        notice = "Reclaimed \(result.sizeHuman) from \(result.volume)."
    }

    /// CONFIRM FIRST. Iterates (§9): there is no bulk CLI call, and doing them
    /// one at a time means one failure doesn't hide the rest.
    func reclaimAll(volumes: [OrphanedVolume]) async {
        guard !isBusy else { return }
        var reclaimed = 0
        var failure: BardolierFailure?

        activity = "Reclaiming \(volumes.count) volume\(volumes.count == 1 ? "" : "s")"
        lastError = nil
        notice = nil
        for volume in volumes {
            do {
                let result = try await client.removeVolume(name: volume.name)
                if result.removed { reclaimed += result.sizeBytes }
            } catch let error as BardolierFailure {
                // Keep going: one volume still held by a container must not
                // strand the others.
                failure = error
            } catch {
                failure = .unexpectedFailure(exitCode: -1, stdout: "", stderr: String(describing: error))
            }
        }
        activity = nil
        notice = "Reclaimed \(BardolierFormat.bytes(reclaimed))."
        await refresh(force: true)
        // After the refresh, for the reason `perform` explains.
        if let failure {
            lastError = failure
        }
    }

    /// Close all & eject (§10). Never forces; on EJECT_BLOCKED the failure
    /// carries `holders`, which the view renders — and the flow stays on that
    /// state so Retry is a click rather than a fresh start.
    ///
    /// Retry IS this method: `bardolier eject` is idempotent in the way that
    /// matters (it stops what is up, checks again, unmounts), so a second call
    /// after the user quits Xcode is the whole recovery.
    ///
    /// `stopDocker` is the one thing this flow can escalate, and only because
    /// the user pressed the button that says so: Docker Desktop's VM holds the
    /// SSD for as long as it runs, so a disk with every container stopped can
    /// still be refused, and no Retry ever clears it. It stops the ENGINE, not
    /// a holder — nothing is killed and nothing is forced.
    ///
    /// `root` names which configured root to eject (phase 18) — `nil` defers
    /// to the CLI, which requires a name only when more than one configured
    /// root is a mounted, removable volume. `all` (phase 22) ejects every
    /// removable root instead, best-effort — mutually exclusive with `root`,
    /// and Retry after a mixed result is this method again unchanged: a root
    /// this call already ejected has unmounted itself out of the next call's
    /// candidates, so a retry only ever revisits what is still stuck.
    func closeAllAndEject(root: String? = nil, all: Bool = false, stopDocker: Bool = false) async {
        guard !isBusy else { return }

        // No configured root is a removable volume: `eject` would only ever
        // answer EJECT_NOT_APPLICABLE, and it does so BEFORE stopping
        // anything (cli-spec.md §6) — so routing this through `eject` would
        // leave every project running behind a menu item that says "Close
        // all". Call `down-all` directly instead; there is no eject flow to
        // land in, so `ejectPhase` stays untouched.
        guard anyRootRemovable else {
            let result = await perform("Closing everything") { client in
                try await client.downAll()
            }
            guard let result else { return }
            notice = result.stopped.isEmpty ? "Nothing was running." : "Stopped \(result.stopped.joined(separator: ", "))."
            return
        }

        ejectPhase = .working

        if all {
            let result = await perform(stopDocker ? "Stopping Docker, then ejecting every disk" : "Ejecting every disk") { client in
                try await client.ejectAll(stopDocker: stopDocker)
            }

            if let result {
                ejected = result.results.allSatisfy(\.ejected)
                ejectPhase = .ejectedAll(results: result.results, stopped: result.stopped)
                // A banner only for the clean sweep — a mixed result is
                // rendered in the panel itself (who ejected, who is still
                // held), the same reasoning that keeps a single blocked eject
                // out of the banner (§10, §13).
                if ejected {
                    let names = result.results.map(\.root).joined(separator: ", ")
                    let stopped = result.stopped.isEmpty ? "" : " Stopped \(result.stopped.joined(separator: ", "))."
                    notice = "\(names) ejected — safe to unplug.\(stopped)"
                }
                return
            }

            guard let failure = lastError else {
                ejectPhase = .ready
                return
            }
            if failure.code == .ejectNotApplicable {
                ejectPhase = .notApplicable(message: failure.failureReason ?? failure.errorDescription ?? "There’s nothing to eject.")
                lastError = nil
            } else {
                ejectPhase = .failed(message: failure.errorDescription ?? "The eject didn’t happen.")
            }
            return
        }

        let result = await perform(stopDocker ? "Stopping Docker, then ejecting" : "Ejecting") { client in
            try await client.eject(root: root, stopDocker: stopDocker)
        }

        if let result {
            ejected = result.ejected
            ejectPhase = .ejected(volume: result.volume, stopped: result.stopped)
            let stopped = result.stopped.isEmpty ? "" : " Stopped \(result.stopped.joined(separator: ", "))."
            let engine = result.dockerStopped == true ? " The Docker engine was stopped — start it again before your next Start." : ""
            notice = "\(result.volume) ejected — safe to unplug.\(stopped)\(engine)"
            return
        }

        // `perform` left the failure in `lastError`. A blocked eject is not a
        // banner: the panel renders the holders and offers Retry, so the error
        // is moved into the phase rather than shown twice (§10, §13).
        guard let failure = lastError else {
            ejectPhase = .ready
            return
        }
        if failure.isRuntimeHold || failure.isRuntimeHoldAfterStop {
            ejectPhase = .blockedByDocker(
                holders: failure.holders,
                message: failure.failureReason ?? "Docker’s virtual machine is still holding the SSD.",
                engineStopped: failure.isRuntimeHoldAfterStop
            )
            lastError = nil
        } else if failure.code == .ejectBlocked {
            ejectPhase = .blocked(
                holders: failure.holders,
                message: failure.failureReason ?? "Something is still holding the SSD."
            )
            lastError = nil
        } else if failure.code == .ejectNotApplicable {
            ejectPhase = .notApplicable(message: failure.failureReason ?? failure.errorDescription ?? "There’s nothing to eject.")
            lastError = nil
        } else {
            ejectPhase = .failed(message: failure.errorDescription ?? "The eject didn’t happen.")
        }
    }

    /// Leave the eject flow without retrying — the user changed their mind, or
    /// the disk is out and the panel has been read.
    func resetEject() {
        if ejectPhase != .working { ejectPhase = .ready }
    }

    /// Preferences (§12). Writes through the CLI so the config file has one
    /// writer, then re-reads what the CLI now believes.
    func setConfig(_ key: ConfigKey, to value: String) async {
        let result = await perform("Saving preferences", refresh: false) { client in
            try await client.configSet(key, to: value)
        }
        guard let result else { return }
        cliConfig = ConfigGetOutput(path: result.path, exists: true, config: result.config, overrides: result.overrides)
        if result.overrides.contains("BARDOLIER_\(key.rawValue.uppercased())") {
            notice = "Saved, but $BARDOLIER_\(key.rawValue.uppercased()) still wins for this one."
        } else if result.changed.isEmpty {
            notice = "No change."
        } else {
            notice = "Saved to \(result.path)."
        }
        // The catalogue may move with catalogue_path (§4.1). Roots have their
        // own surface (`addRoot`/`removeRoot` below) since they are
        // list-valued and not settable through `config set` (phase 18).
        if key == .cataloguePath {
            await loadCatalogue(force: true)
            await loadDoctor()
        }
        await refresh(force: true)
    }

    /// Every configured root (phase 18) — `roots[0]` is the default `new`
    /// targets. Derived from `status`, which already carries it and is kept
    /// fresh by `refresh()`: a separate fetch would just be a second copy of
    /// the same answer, one refresh cycle staler.
    var roots: [ConfiguredRoot] { status?.roots ?? [] }

    /// The `ssd` doctor finding's per-root state (phase 18) — `nil` before
    /// `doctor` has answered.
    private var doctorRoots: [DoctorRootState]? {
        doctor?.findings.first { $0.id == .ssd }?.roots
    }

    /// Whether ANY configured root is an actual removable volume, as opposed
    /// to a plain directory on the internal disk. Drives whether the menu
    /// offers "Close all & eject" or plain "Close all" (§10, §11) — `eject`
    /// on an all-internal setup would only ever answer EJECT_NOT_APPLICABLE,
    /// which is not worth discovering by clicking. `true` while `doctor`
    /// hasn't answered yet, so the row doesn't flicker from "eject" to
    /// "close all" and back on every launch.
    var anyRootRemovable: Bool {
        doctorRoots?.contains { $0.removable == true } ?? true
    }

    /// Whether the DEFAULT root (`status.ssd`) is a removable volume, an
    /// internal-disk directory, or (root absent) unknown. Drives whether the
    /// status line and its degraded reason speak of an "SSD" at all (§5, §11)
    /// — `nil` while `doctor` hasn't answered, or the root isn't mounted and
    /// there is nothing for `diskutil` to have told it.
    var defaultRootRemovable: Bool? {
        guard let name = roots.first?.name else { return nil }
        return doctorRoots?.first { $0.name == name }?.removable
    }

    /// Configured roots that are actually eject candidates: mounted, and an
    /// actually-removable volume — never a plain directory on the internal
    /// disk (phase 22). What `EjectPanel`'s root picker offers, so it cannot
    /// hand the user a choice that would only ever answer
    /// EJECT_NOT_APPLICABLE. `doctor` not having answered yet reads as "none
    /// known" rather than "all of them" here — the opposite default from
    /// `anyRootRemovable` — because the picker offering a root that turns out
    /// not to qualify is worse than the picker briefly offering none.
    var removableRoots: [ConfiguredRoot] {
        guard let doctorRoots else { return [] }
        let names = Set(doctorRoots.filter { $0.removable == true }.map(\.name))
        return roots.filter { names.contains($0.name) }
    }

    /// Register a root. Adding one means everything the menu shows might now
    /// span a different disk, same as `catalogue_path` changing.
    func addRoot(path: String, name: String?) async {
        let result = await perform("Adding root", refresh: false) { client in
            try await client.rootAdd(path: path, name: name)
        }
        guard let result else { return }
        notice = "Added root \(result.added.name)."
        await loadCatalogue(force: true)
        await loadDoctor()
        await refresh(force: true)
    }

    /// Forgets the root; never touches the directory it pointed at.
    func removeRoot(name: String) async {
        let result = await perform("Removing root", refresh: false) { client in
            try await client.rootRemove(name: name)
        }
        guard let result else { return }
        notice = "Forgot root \(result.removed.name)."
        await refresh(force: true)
    }

    func clearError() {
        lastError = nil
    }

    func clearNotice() {
        notice = nil
    }

    func clearShellDowngrade() {
        shellDowngrade = nil
    }

    // MARK: - Running one thing at a time

    /// Run one CLI call as THE current activity: refuse to start a second,
    /// reduce a failure to `lastError`, and refresh afterwards (§4).
    private func perform<T: Sendable>(
        _ label: String,
        refresh shouldRefresh: Bool = true,
        _ work: @Sendable (BardolierClient) async throws -> T
    ) async -> T? {
        guard !isBusy else { return nil }
        activity = label
        lastError = nil
        notice = nil

        var value: T?
        var failure: BardolierFailure?
        do {
            value = try await work(client)
        } catch let error as BardolierFailure {
            failure = error
        } catch {
            failure = .unexpectedFailure(exitCode: -1, stdout: "", stderr: String(describing: error))
        }

        activity = nil
        // Refresh even after a failure: a command that failed part-way through
        // still changed the world, and the menu must show what IS, not what
        // was asked for.
        if shouldRefresh {
            await refresh(force: true)
        }
        // AFTER the refresh, which clears `lastError` when it succeeds — the
        // refusal the user needs to read must outlive the poll that follows it.
        if let failure {
            lastError = failure
        }
        return value
    }
}

/// Byte formatting for the one number the app computes rather than reads: the
/// total of several `size_bytes` the CLI reported individually.
nonisolated enum BardolierFormat {
    static func bytes(_ count: Int) -> String {
        let formatter = ByteCountFormatter()
        formatter.countStyle = .file
        return formatter.string(fromByteCount: Int64(count))
    }
}
