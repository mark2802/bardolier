//
//  MenuBarRootView.swift
//  claude-yard
//
//  The menu (app-spec.md §5), and the panels it opens.
//
//  Structure is §5's, in order: a non-interactive status line, the projects
//  with their per-project actions, then New project / Reclaim disk / Close all
//  & eject, then Preferences and Quit. Everything below the status line is
//  disabled while a command is running (§4) or while the environment can't
//  support it (§11) — and when something is disabled the menu says why rather
//  than leaving a dead item.
//
//  Sub-panels replace the menu inside the same popover instead of opening
//  windows. An LSUIElement app has no windows to return to, and a modal it
//  can't bring forward is worse than no modal; keeping New project, Services,
//  Reclaim and Preferences in the popover means one place to look and one Back
//  button (§8, §9, §12 are all "small" views by their own description).
//

import AppKit
import SwiftUI

/// Which panel the popover is showing. `.services` carries the project it is
/// for, so the panel is always about a named project rather than "the selected
/// one" — there is no selection to get out of step.
enum MenuPanel: Equatable {
    case root
    case services(project: String)
    case newProject
    case reclaim
    case eject
    case preferences
    case diagnostics
}

struct MenuBarRootView: View {
    @EnvironmentObject private var store: CprojStore
    @EnvironmentObject private var preferences: AppPreferences

    @State private var panel: MenuPanel = .root
    // Accordion, not a Set: expanding a second project while one is already
    // open used to stack both blocks inside the fixed-height scroll area,
    // pushing later rows off the bottom with no visible indicator that they'd
    // scrolled off — that's how Delete… came to look state-gated.
    @State private var expandedProject: String?
    @State private var confirmation: ConfirmationRequest?

    // Option-held state for the root-shell alternate item (phase 14). Started
    // and stopped with the menu, not a permanent global monitor.
    @StateObject private var optionKey = OptionKeyObserver()

    var body: some View {
        VStack(spacing: 0) {
            if let confirmation {
                ConfirmationPanel(request: confirmation) { self.confirmation = nil }
            } else {
                switch panel {
                case .root:
                    rootMenu
                case .services(let project):
                    ServicesPanel(projectName: project) { panel = .root }
                case .newProject:
                    NewProjectPanel { panel = .root }
                case .reclaim:
                    ReclaimPanel(confirm: request) { panel = .root }
                case .eject:
                    EjectPanel { panel = .root }
                case .preferences:
                    PreferencesPanel { panel = .root }
                case .diagnostics:
                    DebugStatusView { panel = .root }
                }
            }
        }
        .frame(width: menuWidth)
        .environmentObject(optionKey)
        // §4: refresh on every menu open, debounced by the store.
        .task { await store.appear() }
        .onAppear { optionKey.start() }
        .onDisappear { optionKey.stop() }
    }

    // MARK: - The menu itself (§5)

    private var rootMenu: some View {
        VStack(alignment: .leading, spacing: 0) {
            statusLine
            Divider().padding(.vertical, 4)

            // §13: with no `cproj` there is nothing to show and nothing to
            // offer, so the menu says THAT rather than failing item by item.
            if store.cprojMissing {
                FirstRunPanel()
                Divider().padding(.vertical, 4)
                MenuTextRow(title: "Preferences…", systemImage: "gearshape") { panel = .preferences }
                MenuTextRow(title: "Quit", systemImage: "power") { NSApplication.shared.terminate(nil) }
            } else {
                fullMenu
            }
        }
        .padding(.bottom, 6)
    }

    private var fullMenu: some View {
        VStack(alignment: .leading, spacing: 0) {
            banners

            ScrollView {
                VStack(alignment: .leading, spacing: 0) {
                    MenuSectionHeader(title: "Projects")
                    // Said once, here, rather than under each dimmed action.
                    if let reason = mutationBlockedReason, !store.projects.isEmpty {
                        DisabledNotice(reason: reason)
                    }
                    projectList
                }
            }
            // A row clipped by maxHeight below with no visible scrollbar reads
            // as absent rather than scrollable — that's how Delete… came to
            // look state-gated when it was really just off the bottom of an
            // unindicated scroll area. The accordion above bounds a single
            // expansion's height; a long collapsed project list can still
            // overflow, so the indicator stays.
            .scrollIndicators(.visible)
            .frame(maxHeight: 360)

            Divider().padding(.vertical, 4)

            MenuTextRow(
                title: "New project…",
                systemImage: "plus.square",
                isDisabled: !canMutate,
                disabledReason: mutationBlockedReason
            ) {
                panel = .newProject
            }
            MenuTextRow(
                title: reclaimTitle,
                systemImage: "internaldrive",
                isDisabled: !canMutate,
                disabledReason: mutationBlockedReason
            ) {
                panel = .reclaim
            }
            // §10 is a FLOW, not a single click: it can come back blocked with
            // a holder list the user acts on and retries. It gets a panel, and
            // the row says where that flow got to.
            MenuTextRow(
                title: ejectTitle,
                systemImage: ejectSymbol,
                isDisabled: !canOpenEject,
                disabledReason: ejectDisabledReason
            ) {
                panel = .eject
            }

            Divider().padding(.vertical, 4)

            MenuTextRow(title: "Preferences…", systemImage: "gearshape") { panel = .preferences }
            MenuTextRow(title: "Diagnostics…", systemImage: "stethoscope") { panel = .diagnostics }
            MenuTextRow(title: "Quit", systemImage: "power") { NSApplication.shared.terminate(nil) }
        }
        .padding(.bottom, 6)
    }

    /// §5's status line: non-interactive, and the one place the activity state
    /// is spelled out in words as well as in the icon (§11).
    private var statusLine: some View {
        HStack(spacing: 6) {
            Circle()
                .fill(store.isDegraded ? Color.secondary : Color.green)
                .frame(width: 8, height: 8)
            VStack(alignment: .leading, spacing: 1) {
                Text(store.ssdSummary).font(.caption.weight(.medium))
                if let activity = store.activity {
                    Text("\(activity)…").font(.caption2).foregroundStyle(.secondary)
                } else if let reason = store.degradedReason {
                    Text(reason).font(.caption2).foregroundStyle(.secondary)
                } else if store.status?.docker.available == true {
                    Text("Docker running").font(.caption2).foregroundStyle(.secondary)
                }
            }
            Spacer(minLength: 0)
            if store.isBusy {
                ProgressView().controlSize(.small)
            }
        }
        .padding(.horizontal, 10)
        .padding(.top, 8)
    }

    @ViewBuilder
    private var banners: some View {
        if let notice = store.notice {
            NoticeBanner(text: notice) { store.clearNotice() }
                .padding(.bottom, 4)
        }
        if let error = store.lastError {
            ErrorBanner(failure: error) { store.clearError() }
                .padding(.bottom, 4)
        }
        // Last, and outliving both of the above: a shell that opened by the
        // lesser route stays said until the user fixes it or dismisses it.
        if let downgrade = store.shellDowngrade {
            WarningBanner(text: downgrade) { store.clearShellDowngrade() }
                .padding(.bottom, 4)
        }
    }

    @ViewBuilder
    private var projectList: some View {
        if store.projects.isEmpty {
            Text(store.status == nil ? "Loading…" : emptyProjectsMessage)
                .font(.caption)
                .foregroundStyle(.secondary)
                .padding(.horizontal, 10)
                .padding(.vertical, 6)
        } else {
            ForEach(store.projects) { project in
                ProjectRow(
                    project: project,
                    isExpanded: expandedProject == project.name,
                    canMutate: canMutate,
                    disabledReason: mutationBlockedReason,
                    toggleExpanded: { toggle(project.name) },
                    openServices: { panel = .services(project: project.name) },
                    confirm: request
                )
            }
        }
    }

    private var emptyProjectsMessage: String {
        store.isDegraded ? "Nothing to show while the SSD is away." : "No projects yet. Create one below."
    }

    private var reclaimTitle: String {
        let count = store.orphanedVolumes.count
        return count == 0 ? "Reclaim disk…" : "Reclaim disk… (\(count))"
    }

    // MARK: - Enablement (§4, §11)

    /// Mutating actions need an idle app, a mounted SSD and a live daemon.
    private var canMutate: Bool { !store.isBusy && !store.isDegraded }

    /// Why they are inert, in the same order they are refused. Nil when they
    /// are not — so a row can hand this straight to `disabledReason` (§11).
    ///
    /// This exists because a dimmed row and an absent row look the same. The
    /// status line has always carried `degradedReason`, but it is one caption at
    /// the top of the popover and the disabled item may be three sections below
    /// it, inside a collapsed project.
    private var mutationBlockedReason: String? {
        if let activity = store.activity { return "Waiting for “\(activity)” to finish." }
        return store.degradedReason
    }

    /// Eject is the exception: it is what you reach for when things are wrong,
    /// so it needs neither Docker nor an idle app to be OPENED — the panel
    /// itself decides whether the button inside it can be pressed, and reading
    /// a holder list while the eject is still running is exactly the point.
    ///
    /// `.notApplicable` (phase 10) is the one phase that closes the row instead
    /// of opening a panel: `ssd_root` is a plain local directory, so there is
    /// nothing a panel could offer beyond the reason, and the row already has
    /// somewhere to put that (`disabledReason`) — the same treatment a missing
    /// archetype Dockerfile gets, not a failure to click into.
    private var canOpenEject: Bool {
        if case .notApplicable = store.ejectPhase { return false }
        return store.status?.ssd.mounted == true || store.ejectPhase != .ready
    }

    /// Why the eject row is dimmed, once `.notApplicable` has been learned —
    /// nil otherwise, so the row carries no help text most of the time.
    private var ejectDisabledReason: String? {
        if case .notApplicable(let message) = store.ejectPhase { return message }
        return nil
    }

    private func toggle(_ name: String) {
        expandedProject = expandedProject == name ? nil : name
    }

    /// Show a confirmation. The panel dismisses itself before running the
    /// action, so nothing here has to unwind it.
    private func request(_ prepared: ConfirmationRequest) {
        confirmation = prepared
    }

    /// The eject row's words, taken from where the flow got to (§10, §11).
    /// A blocked eject must not disappear from the menu just because the panel
    /// was closed — that is the state the user comes back to.
    private var ejectTitle: String {
        switch store.ejectPhase {
        case .blockedByDocker(_, _, let engineStopped):
            return engineStopped
                ? "Eject blocked — engine stopped, still held…"
                : "Eject blocked — Docker is holding it…"
        case .blocked(let holders, _):
            return holders.isEmpty ? "Eject was blocked…" : "Eject blocked — \(holders.count) holder\(holders.count == 1 ? "" : "s")…"
        case .ejected:
            return "Ejected — safe to unplug"
        case .working:
            return "Ejecting…"
        case .notApplicable:
            return "Nothing to eject"
        default:
            return "Close all & eject"
        }
    }

    private var ejectSymbol: String {
        switch store.ejectPhase {
        case .blocked, .blockedByDocker: return "exclamationmark.triangle"
        case .ejected: return "eject.circle"
        default: return "eject"
        }
    }
}

/// One project and its actions (§5). Running shows Stop + Open shell; stopped
/// shows Start. The attached services and their host ports are shown inline —
/// the port is the debugging payoff, so it should not need a click to see.
struct ProjectRow: View {
    @EnvironmentObject private var store: CprojStore
    @EnvironmentObject private var preferences: AppPreferences
    @EnvironmentObject private var optionKey: OptionKeyObserver

    var project: CprojProject
    var isExpanded: Bool
    var canMutate: Bool
    /// Why this row's actions are inert, or nil when they are not (§11).
    var disabledReason: String?
    var toggleExpanded: () -> Void
    var openServices: () -> Void
    var confirm: (ConfirmationRequest) -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            MenuRow(action: toggleExpanded) {
                HStack(spacing: 6) {
                    StateDot(state: project.state)
                    Text(project.name)
                    Text(project.archetype.display)
                        .font(.caption2)
                        .foregroundStyle(.secondary)
                    Spacer(minLength: 0)
                    Image(systemName: isExpanded ? "chevron.down" : "chevron.right")
                        .font(.system(size: 9))
                        .foregroundStyle(.secondary)
                }
            }

            if isExpanded {
                VStack(alignment: .leading, spacing: 0) {
                    if project.state.isUp {
                        MenuTextRow(
                            title: "Stop",
                            systemImage: "stop.circle",
                            isDisabled: !canMutate,
                            disabledReason: disabledReason
                        ) {
                            Task { await store.stop(project: project.name) }
                        }
                        // Option-held swaps to a root shell — same idiom as
                        // Finder's Option-held Secure Empty Trash. The common
                        // case says nothing about this; it's there for whoever
                        // holds the key (phase 14).
                        MenuTextRow(
                            title: optionKey.isOptionHeld ? "Open root shell" : "Open shell",
                            systemImage: optionKey.isOptionHeld ? "terminal.fill" : "terminal",
                            isDisabled: store.isBusy
                        ) {
                            Task { await store.openShell(project: project.name, root: optionKey.isOptionHeld) }
                        }
                    } else {
                        // §7: the auto-shell preference is invisible until it
                        // surprises you, so the item that obeys it says so.
                        MenuTextRow(
                            title: preferences.startOpensShell ? "Start & open shell" : "Start",
                            systemImage: "play.circle",
                            isDisabled: !canMutate,
                            disabledReason: disabledReason
                        ) {
                            Task {
                                await store.start(project: project.name, openShell: preferences.startOpensShell)
                            }
                        }
                    }

                    MenuTextRow(title: "Services…", systemImage: "cylinder.split.1x2", isDisabled: store.isBusy) {
                        openServices()
                    }
                    MenuTextRow(title: "Open folder in Finder", systemImage: "folder") {
                        revealInFinder(project.dir)
                    }
                    MenuTextRow(
                        title: "Delete…",
                        systemImage: "trash",
                        isDisabled: !canMutate,
                        disabledReason: disabledReason
                    ) {
                        confirm(deleteConfirmation)
                    }

                    servicePorts
                }
                .padding(.leading, 14)
                .padding(.bottom, 4)
            }
        }
    }

    /// Attached services with their host ports and click-to-copy connection
    /// strings (§5). The hint is what a GUI tool on the Mac needs; inside the
    /// project the app connects to `<key>:<container_port>` instead.
    @ViewBuilder
    private var servicePorts: some View {
        if !project.services.isEmpty {
            VStack(alignment: .leading, spacing: 2) {
                ForEach(project.services) { service in
                    CopyRow(value: service.connectionHint, help: "Copy \(service.connectionHint)") {
                        Circle()
                            .fill(service.state == .running ? Color.green : Color.secondary.opacity(0.5))
                            .frame(width: 6, height: 6)
                        Text(service.display).font(.caption2)
                        Text(":\(String(service.hostPort))")
                            .font(.caption2.monospaced())
                            .foregroundStyle(.secondary)
                    }
                }
            }
            .padding(.top, 4)
        }
    }

    /// Deleting keeps the data volumes unless the user says otherwise (§9,
    /// CLAUDE.md: never destroy data to save a step).
    private var deleteConfirmation: ConfirmationRequest {
        ConfirmationRequest(
            title: "Delete \(project.name)?",
            detail: "Its containers and its folder on the SSD are removed, and its host ports are released. "
                + "Data volumes are kept and become reclaimable orphans unless you say otherwise.",
            confirmLabel: "Delete",
            toggleLabel: "Also delete its data volumes",
            perform: { purge in
                Task { await store.delete(project: project.name, purge: purge) }
            }
        )
    }
}
