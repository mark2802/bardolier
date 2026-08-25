//
//  EjectPanel.swift
//  claude-yard
//
//  Close all & eject (app-spec.md §10).
//
//  The flow §10 describes has three answers, and only one of them is "done":
//
//    1. `cproj eject --json` — which is itself down-all, then a holder check,
//       then `diskutil` (cli-spec.md §6). The app calls one command; it does
//       not stop projects itself and then unmount, because ordering that
//       sequence is the CLI's job and doing it twice is how the two get out of
//       step.
//    2. EJECT_BLOCKED — the holders are rendered by name and the user is
//       offered RETRY. Nothing here forces, and nothing here offers to kill a
//       holder: `cproj` deliberately has no `--force` to pass, because forcing
//       an unmount out from under a running editor is the data loss the command
//       exists to prevent (CLAUDE.md, safety over convenience).
//    3. Ejected — "safe to unplug", which is also the icon state (§11).
//
//  Retry is simply the same call again, which is why this panel holds no state
//  of its own: `store.ejectPhase` is where the flow lives, so quitting Xcode,
//  reopening the menu and clicking Retry finds the holder list still there.
//

import SwiftUI

struct EjectPanel: View {
    @EnvironmentObject private var store: CprojStore

    var back: () -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            PanelHeader(title: "Close all & eject", back: back)

            ScrollView {
                VStack(alignment: .leading, spacing: 10) {
                    switch store.ejectPhase {
                    case .ready:
                        readyState
                    case .working:
                        workingState
                    case .blocked(let holders, let message):
                        blockedState(holders: holders, message: message)
                    case .ejected(let volume, let stopped):
                        ejectedState(volume: volume, stopped: stopped)
                    case .failed(let message):
                        failedState(message: message)
                    }
                }
                .padding(.horizontal, 12)
            }
            .frame(maxHeight: 340)
        }
        .padding(.bottom, 12)
    }

    // MARK: - Before

    @ViewBuilder
    private var readyState: some View {
        if store.status?.ssd.mounted == false {
            Text("The SSD isn’t mounted, so there is nothing to eject.")
                .font(.caption)
                .foregroundStyle(.secondary)
        } else {
            Text("Every running project is stopped, then the disk is unmounted.")
                .font(.caption)
            Text("If something still has files open on it, cproj says what — and never forces the unmount.")
                .font(.caption2)
                .foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)

            if !runningProjects.isEmpty {
                VStack(alignment: .leading, spacing: 2) {
                    Text("Will be stopped").font(.caption2.weight(.semibold)).foregroundStyle(.secondary)
                    ForEach(runningProjects) { project in
                        HStack(spacing: 6) {
                            StateDot(state: project.state)
                            Text(project.name).font(.caption)
                        }
                    }
                }
            } else {
                Text("Nothing is running.").font(.caption2).foregroundStyle(.tertiary)
            }

            actionButton("Close all & eject", role: .destructive) {
                Task { await store.closeAllAndEject() }
            }
            .disabled(store.isBusy || store.status?.ssd.mounted != true)
        }
    }

    private var workingState: some View {
        HStack(spacing: 8) {
            ProgressView().controlSize(.small)
            Text("Stopping projects, then unmounting…").font(.caption)
        }
    }

    // MARK: - Blocked (§10.2)

    @ViewBuilder
    private func blockedState(holders: [SsdHolder], message: String) -> some View {
        HStack(alignment: .top, spacing: 6) {
            Image(systemName: "exclamationmark.triangle.fill").foregroundStyle(.orange)
            Text(headline(for: holders))
                .font(.caption.weight(.medium))
                .fixedSize(horizontal: false, vertical: true)
        }

        if holders.isEmpty {
            // EJECT_BLOCKED with no holders: diskutil refused for its own
            // reasons, and its refusal is reported as it came (CLAUDE.md).
            Text(message)
                .font(.caption2)
                .foregroundStyle(.secondary)
                .textSelection(.enabled)
                .fixedSize(horizontal: false, vertical: true)
        } else {
            HolderList(holders: holders)
            Text("Quit them, then Retry. cproj will not force an unmount.")
                .font(.caption2)
                .foregroundStyle(.secondary)
        }

        HStack(spacing: 8) {
            actionButton("Retry", role: nil) {
                Task { await store.closeAllAndEject() }
            }
            .disabled(store.isBusy)

            Button("Not now") {
                store.resetEject()
                back()
            }
            .controlSize(.small)
        }
    }

    /// "Xcode, Simulator still hold the SSD — quit them" (§10), in words that
    /// name the apps rather than counting processes.
    private func headline(for holders: [SsdHolder]) -> String {
        guard !holders.isEmpty else { return "The SSD wouldn’t unmount." }
        var names: [String] = []
        for holder in holders where !names.contains(holder.command) {
            names.append(holder.command)
        }
        let listed = names.prefix(3).joined(separator: ", ")
        let rest = names.count > 3 ? " and \(names.count - 3) more" : ""
        return "\(listed)\(rest) still hold\(names.count == 1 ? "s" : "") the SSD — quit them."
    }

    // MARK: - After

    @ViewBuilder
    private func ejectedState(volume: String, stopped: [String]) -> some View {
        HStack(alignment: .top, spacing: 6) {
            Image(systemName: "eject.circle.fill").foregroundStyle(.green)
            VStack(alignment: .leading, spacing: 2) {
                Text("Safe to unplug.").font(.caption.weight(.medium))
                Text(volume)
                    .font(.caption2.monospaced())
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
                    .truncationMode(.middle)
            }
        }
        if stopped.isEmpty {
            Text("Nothing was running.").font(.caption2).foregroundStyle(.tertiary)
        } else {
            Text("Stopped \(stopped.joined(separator: ", ")). Their data is untouched.")
                .font(.caption2)
                .foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)
        }
        Text("Plug the disk back in and the menu picks it up on the next open.")
            .font(.caption2)
            .foregroundStyle(.tertiary)
            .fixedSize(horizontal: false, vertical: true)
    }

    @ViewBuilder
    private func failedState(message: String) -> some View {
        HStack(alignment: .top, spacing: 6) {
            Image(systemName: "exclamationmark.triangle.fill").foregroundStyle(.orange)
            Text(message)
                .font(.caption)
                .textSelection(.enabled)
                .fixedSize(horizontal: false, vertical: true)
        }
        HStack(spacing: 8) {
            actionButton("Try again", role: nil) {
                Task { await store.closeAllAndEject() }
            }
            .disabled(store.isBusy)

            Button("Not now") {
                store.resetEject()
                back()
            }
            .controlSize(.small)
        }
    }

    // MARK: - Plumbing

    private var runningProjects: [CprojProject] {
        store.projects.filter { $0.state.isUp }
    }

    private func actionButton(_ title: String, role: ButtonRole?, action: @escaping () -> Void) -> some View {
        Button(title, role: role, action: action)
            .buttonStyle(.borderedProminent)
            .controlSize(.small)
            .tint(role == .destructive ? .red : .accentColor)
    }
}
