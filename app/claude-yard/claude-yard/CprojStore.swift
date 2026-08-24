//
//  CprojStore.swift
//  claude-yard
//
//  What the menu bar is currently looking at.
//
//  The store holds NO truth of its own: it holds the last answer the CLI gave
//  and the fact that a call is in flight. Nothing here computes a project's
//  state, a port, or whether a volume is reclaimable — those are answers, and
//  answers come from `cproj` (CLAUDE.md, app-spec.md §4).
//
//  Phase 5 gives it exactly what the debug view needs: launch checks, a
//  debounced refresh, and one place for the last error. The mutating actions
//  (start, stop, delete, attach, reclaim, eject) hang off the same client in
//  Phase 6.
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
    /// The most recent failure, already reduced to a human sentence (§13).
    @Published private(set) var lastError: CprojFailure?
    /// True while a call is outstanding — the activity icon state (§11) and
    /// what disables conflicting actions.
    @Published private(set) var isBusy = false
    /// Where `cproj` was found, for the debug view and the first-run message.
    @Published private(set) var executablePath: String?
    /// When the current `status` was taken.
    @Published private(set) var lastRefresh: Date?

    private let client: CprojClient
    private var refreshTask: Task<Void, Never>?

    /// §4 asks for a refresh on every menu open; reopening the menu twice in a
    /// second shouldn't queue two subprocesses behind each other.
    private let minimumInterval: TimeInterval = 0.5

    init(client: CprojClient = CprojClient()) {
        self.client = client
    }

    /// Icon state, derived purely from the latest status/doctor (§11). The
    /// ejected state arrives with the eject flow in Phase 7.
    var iconSymbol: String {
        if isBusy { return "shippingbox.circle" }
        guard let status else { return "shippingbox" }
        if !status.ssd.mounted || !status.docker.available { return "shippingbox.badge.exclamationmark" }
        return "shippingbox.fill"
    }

    var isDegraded: Bool {
        guard let status else { return true }
        return !status.ssd.mounted || !status.docker.available
    }

    /// What every menu open does (app-spec.md §4): the first one runs the
    /// launch checks, every later one just refreshes — debounced.
    func appear() async {
        if doctor == nil {
            await start()
        } else {
            await refresh()
        }
    }

    /// Launch sequence: run `doctor`, then take a first status.
    func start() async {
        await loadDoctor()
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
            isBusy = true
            defer { isBusy = false }
            // Re-resolved every time, like the client does: installing `cproj`
            // or setting the preference then fixes a first-run failure on the
            // next menu open rather than on the next launch.
            executablePath = try? CprojExecutable.resolve().path
            do {
                status = try await client.status()
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

    func clearError() {
        lastError = nil
    }
}
