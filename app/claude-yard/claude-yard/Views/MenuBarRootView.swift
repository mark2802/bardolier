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
    case preferences
    case diagnostics
}

struct MenuBarRootView: View {
    @EnvironmentObject private var store: CprojStore
    @EnvironmentObject private var preferences: AppPreferences

    @State private var panel: MenuPanel = .root
    @State private var expanded: Set<String> = []
    @State private var confirmation: ConfirmationRequest?

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
                case .preferences:
                    PreferencesPanel { panel = .root }
                case .diagnostics:
                    DebugStatusView { panel = .root }
                }
            }
        }
        .frame(width: menuWidth)
        // §4: refresh on every menu open, debounced by the store.
        .task { await store.appear() }
    }

    // MARK: - The menu itself (§5)

    private var rootMenu: some View {
        VStack(alignment: .leading, spacing: 0) {
            statusLine
            Divider().padding(.vertical, 4)
            banners

            ScrollView {
                VStack(alignment: .leading, spacing: 0) {
                    MenuSectionHeader(title: "Projects")
                    projectList
                }
            }
            .frame(maxHeight: 360)

            Divider().padding(.vertical, 4)

            MenuTextRow(title: "New project…", systemImage: "plus.square", isDisabled: !canMutate) {
                panel = .newProject
            }
            MenuTextRow(title: reclaimTitle, systemImage: "internaldrive", isDisabled: !canMutate) {
                panel = .reclaim
            }
            MenuTextRow(title: "Close all & eject", systemImage: "eject", isDisabled: !canEject) {
                request(ejectConfirmation)
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
                    isExpanded: expanded.contains(project.name),
                    canMutate: canMutate,
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

    /// Eject is the exception: it is what you reach for when things are wrong,
    /// so it only needs the SSD to be there and nothing else running.
    private var canEject: Bool { !store.isBusy && store.status?.ssd.mounted == true }

    private func toggle(_ name: String) {
        if expanded.contains(name) {
            expanded.remove(name)
        } else {
            expanded.insert(name)
        }
    }

    /// Show a confirmation. The panel dismisses itself before running the
    /// action, so nothing here has to unwind it.
    private func request(_ prepared: ConfirmationRequest) {
        confirmation = prepared
    }

    /// Close all & eject (§10). Confirmed because it stops every project.
    private var ejectConfirmation: ConfirmationRequest {
        ConfirmationRequest(
            title: "Close all & eject?",
            detail: "Every running project is stopped, then the SSD is unmounted. "
                + "If something still holds the disk, cproj reports it and does not force.",
            confirmLabel: "Eject",
            toggleLabel: nil,
            perform: { _ in
                Task { await store.closeAllAndEject() }
            }
        )
    }
}

/// One project and its actions (§5). Running shows Stop + Open shell; stopped
/// shows Start. The attached services and their host ports are shown inline —
/// the port is the debugging payoff, so it should not need a click to see.
struct ProjectRow: View {
    @EnvironmentObject private var store: CprojStore
    @EnvironmentObject private var preferences: AppPreferences

    var project: CprojProject
    var isExpanded: Bool
    var canMutate: Bool
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
                        MenuTextRow(title: "Stop", systemImage: "stop.circle", isDisabled: !canMutate) {
                            Task { await store.stop(project: project.name) }
                        }
                        MenuTextRow(title: "Open shell", systemImage: "terminal", isDisabled: store.isBusy) {
                            Task { await store.openShell(project: project.name) }
                        }
                    } else {
                        MenuTextRow(title: "Start", systemImage: "play.circle", isDisabled: !canMutate) {
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
                    MenuTextRow(title: "Delete…", systemImage: "trash", isDisabled: !canMutate) {
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
                    HStack(spacing: 6) {
                        Circle()
                            .fill(service.state == .running ? Color.green : Color.secondary.opacity(0.5))
                            .frame(width: 6, height: 6)
                        Text(service.display).font(.caption2)
                        Text(":\(String(service.hostPort))")
                            .font(.caption2.monospaced())
                            .foregroundStyle(.secondary)
                        Spacer(minLength: 0)
                        CopyButton(value: service.connectionHint, help: "Copy \(service.connectionHint)")
                    }
                }
            }
            .padding(.horizontal, 10)
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
