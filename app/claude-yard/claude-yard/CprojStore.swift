//
//  CprojStore.swift
//  claude-yard
//
//  What the menu bar is currently looking at, and the one place an action runs.
//
//  The store holds NO truth of its own: it holds the last answer the CLI gave
//  and the fact that a call is in flight. Nothing here computes a project's
//  state, a port, or whether a volume is reclaimable — those are answers, and
//  answers come from `cproj` (CLAUDE.md, app-spec.md §4).
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
//  `CprojClient` passes `--force`, because the CLI cannot prompt with no
//  terminal (app-spec.md §6, §9).
//

// Combine is imported directly, not by way of SwiftUI: the target builds with
// MemberImportVisibility, under which a transitively-imported module's members
// are not visible — and ObservableObject's synthesized `objectWillChange` is
// one of Combine's.
import Combine
import Foundation
import SwiftUI

@MainActor
final class CprojStore: ObservableObject {
    /// The last `cproj status --json`, or nil before the first successful call.
    @Published private(set) var status: CprojStatus?
    /// The last `cproj doctor --json` — the launch check (app-spec.md §4).
    @Published private(set) var doctor: DoctorOutput?
    /// Every service the catalogue defines (§6, §8). Loaded once, on demand.
    @Published private(set) var catalogue: CatalogueOutput?
    /// The effective CLI config — what Preferences edits (§12).
    @Published private(set) var cliConfig: ConfigGetOutput?
    /// The most recent failure, already reduced to a human sentence (§13).
    @Published private(set) var lastError: CprojFailure?
    /// The result of the last action worth reporting — an assigned host port,
    /// a kept volume, reclaimed bytes (§6, §9).
    @Published private(set) var notice: String?
    /// What is running right now, or nil when idle. Drives the activity icon
    /// (§11) and disables conflicting actions (§4).
    @Published private(set) var activity: String?
    /// Where `cproj` was found, for Preferences and the first-run message.
    @Published private(set) var executablePath: String?
    /// When the current `status` was taken.
    @Published private(set) var lastRefresh: Date?
    /// Set by a successful eject and cleared the moment the SSD is seen
    /// mounted again — the "safe to unplug" icon state (§10, §11).
    @Published private(set) var ejected = false

    private let client: CprojClient
    private var refreshTask: Task<Void, Never>?

    /// §4 asks for a refresh on every menu open; reopening the menu twice in a
    /// second shouldn't queue two subprocesses behind each other.
    private let minimumInterval: TimeInterval = 0.5

    init(client: CprojClient = CprojClient()) {
        self.client = client
    }

    // MARK: - Derived state (all of it from the last status/doctor, §11)

    var isBusy: Bool { activity != nil }

    /// Icon state, derived purely from the latest status/doctor (§11).
    var iconSymbol: String {
        if isBusy { return "shippingbox.circle" }
        if ejected { return "eject.circle" }
        guard let status else { return "shippingbox" }
        // `externaldrive.badge.exclamationmark` rather than a shipping box with
        // a badge: no such box symbol exists, and an icon macOS can't resolve
        // draws as NOTHING — a blank menu bar for exactly the state §11 most
        // needs to show. Symbol names are checked in test/phase6-done-check.sh.
        if !status.ssd.mounted || !status.docker.available { return "externaldrive.badge.exclamationmark" }
        return "shippingbox.fill"
    }

    /// True when the environment can't do the thing the menu is offering —
    /// every mutating item is disabled and says why.
    var isDegraded: Bool {
        guard let status else { return true }
        return !status.ssd.mounted || !status.docker.available
    }

    /// One line for the top of the menu (§5's status line).
    var ssdSummary: String {
        guard let status else { return "SSD: checking…" }
        if ejected && !status.ssd.mounted { return "SSD: ejected — safe to unplug" }
        if !status.ssd.mounted { return "SSD: not mounted (\(status.ssd.root))" }
        return "SSD: mounted (\(status.ssd.root))"
    }

    /// Why the mutating items are disabled, or nil when they aren't.
    var degradedReason: String? {
        guard let status else { return nil }
        if !status.ssd.mounted { return ejected ? "Plug the SSD back in to carry on." : "Plug the SSD in, or set its path in Preferences." }
        if !status.docker.available { return "Start Docker Desktop to run projects." }
        return nil
    }

    var projects: [CprojProject] { status?.projects ?? [] }
    var orphanedVolumes: [OrphanedVolume] { status?.orphanedVolumes ?? [] }

    func project(named name: String) -> CprojProject? {
        projects.first { $0.name == name }
    }

    /// The terminal the CLI config names — the single source for it (§8, §12).
    var terminalName: String { cliConfig?.config.terminal ?? CprojTerminal.fallbackName }

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

            // Re-resolved every time, like the client does: installing `cproj`
            // or setting the preference then fixes a first-run failure on the
            // next menu open rather than on the next launch.
            executablePath = try? CprojExecutable.resolve().path
            do {
                let fresh = try await client.status()
                status = fresh
                // The SSD coming back is the only thing that clears "ejected";
                // deriving it from status is what keeps §11 honest when the
                // user replugs the disk without touching the menu.
                if fresh.ssd.mounted { ejected = false }
                lastRefresh = Date()
                lastError = nil
            } catch let failure as CprojFailure {
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
        } catch let failure as CprojFailure {
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
        } catch let failure as CprojFailure {
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
        } catch let failure as CprojFailure {
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
        } catch let failure as CprojFailure {
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

    /// CONFIRM FIRST — the client passes `--force` (§9). `purge` destroys the
    /// project's volumes; the default keeps them as reclaimable orphans.
    func delete(project name: String, purge: Bool) async {
        let result = await perform("Deleting \(name)") { client in
            try await client.delete(project: name, purge: purge)
        }
        guard let result, result.deleted else { return }
        if result.removedVolumes.isEmpty {
            let kept = result.keptVolumes.count
            notice = kept == 0
                ? "Deleted \(name)."
                : "Deleted \(name). \(kept) volume\(kept == 1 ? "" : "s") kept — reclaim them from Reclaim disk."
        } else {
            notice = "Deleted \(name) and \(result.removedVolumes.count) volume(s)."
        }
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

    /// Detach a service. The volume is KEPT and becomes a listed orphan (§6).
    func detach(service key: String, from name: String) async {
        let result = await perform("Detaching \(key) from \(name)") { client in
            try await client.serviceRemove(project: name, service: key)
        }
        guard let result else { return }
        let volume = result.removed.volume.map { " Its volume \($0) is kept — reclaim it from Reclaim disk." } ?? ""
        notice = "Detached \(result.removed.key); host port \(result.removed.hostPort) released.\(volume)"
    }

    /// Create a project (§8). Returns the payload so the window can close only
    /// on success, and reports the ports any initial services were assigned.
    @discardableResult
    func create(name: String, archetype: Archetype, services: [String]) async -> NewOutput? {
        let result = await perform("Creating \(name)") { client in
            try await client.new(name: name, archetype: archetype, services: services)
        }
        guard let result else { return nil }
        let ports = result.services.map { "\($0.key) :\($0.hostPort)" }.joined(separator: ", ")
        notice = ports.isEmpty ? "Created \(name)." : "Created \(name) — \(ports)."
        return result
    }

    /// Open a shell in the configured terminal (§7). The CLI names the command;
    /// the app is what runs it.
    func openShell(project name: String) async {
        do {
            let invocation = try await client.shell(project: name)
            // A note comes back when the shell opened by a lesser route — say
            // so, rather than letting a silent downgrade look like normal.
            if let note = try CprojTerminal.open(invocation, in: terminalName) {
                notice = note
            }
        } catch let failure as CprojFailure {
            lastError = failure
        } catch let failure as TerminalFailure {
            lastError = .launchFailed(path: terminalName, underlying: failure.message)
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
        var failure: CprojFailure?

        activity = "Reclaiming \(volumes.count) volume\(volumes.count == 1 ? "" : "s")"
        lastError = nil
        notice = nil
        for volume in volumes {
            do {
                let result = try await client.removeVolume(name: volume.name)
                if result.removed { reclaimed += result.sizeBytes }
            } catch let error as CprojFailure {
                // Keep going: one volume still held by a container must not
                // strand the others.
                failure = error
            } catch {
                failure = .unexpectedFailure(exitCode: -1, stdout: "", stderr: String(describing: error))
            }
        }
        activity = nil
        notice = "Reclaimed \(CprojFormat.bytes(reclaimed))."
        await refresh(force: true)
        // After the refresh, for the reason `perform` explains.
        if let failure {
            lastError = failure
        }
    }

    /// Close all & eject (§10). Never forces; on EJECT_BLOCKED the failure
    /// carries `holders`, which the view renders.
    func closeAllAndEject() async {
        let result = await perform("Ejecting") { client in
            try await client.eject()
        }
        guard let result else { return }
        ejected = result.ejected
        let stopped = result.stopped.isEmpty ? "" : " Stopped \(result.stopped.joined(separator: ", "))."
        notice = "\(result.volume) ejected — safe to unplug.\(stopped)"
    }

    /// Preferences (§12). Writes through the CLI so the config file has one
    /// writer, then re-reads what the CLI now believes.
    func setConfig(_ key: ConfigKey, to value: String) async {
        let result = await perform("Saving preferences", refresh: false) { client in
            try await client.configSet(key, to: value)
        }
        guard let result else { return }
        cliConfig = ConfigGetOutput(path: result.path, exists: true, config: result.config, overrides: result.overrides)
        if result.overrides.contains("CPROJ_\(key.rawValue.uppercased())") {
            notice = "Saved, but $CPROJ_\(key.rawValue.uppercased()) still wins for this one."
        } else if result.changed.isEmpty {
            notice = "No change."
        } else {
            notice = "Saved to \(result.path)."
        }
        // The SSD path changing means everything the menu shows is about a
        // different disk; the catalogue may move with it (§4.1).
        if key == .ssdRoot || key == .ssdVolume || key == .cataloguePath {
            await loadCatalogue(force: true)
            await loadDoctor()
        }
        await refresh(force: true)
    }

    func clearError() {
        lastError = nil
    }

    func clearNotice() {
        notice = nil
    }

    // MARK: - Running one thing at a time

    /// Run one CLI call as THE current activity: refuse to start a second,
    /// reduce a failure to `lastError`, and refresh afterwards (§4).
    private func perform<T: Sendable>(
        _ label: String,
        refresh shouldRefresh: Bool = true,
        _ work: @Sendable (CprojClient) async throws -> T
    ) async -> T? {
        guard !isBusy else { return nil }
        activity = label
        lastError = nil
        notice = nil

        var value: T?
        var failure: CprojFailure?
        do {
            value = try await work(client)
        } catch let error as CprojFailure {
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
nonisolated enum CprojFormat {
    static func bytes(_ count: Int) -> String {
        let formatter = ByteCountFormatter()
        formatter.countStyle = .file
        return formatter.string(fromByteCount: Int64(count))
    }
}
