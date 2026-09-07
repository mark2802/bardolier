//
//  MovePanel.swift
//  Bardolier
//
//  Move a project to another configured root (app-spec.md §8.2, phase 21/26).
//
//  Unlike `ClonePanel`, there is nothing to type: `move` takes no name and no
//  content choice, so this is a root picker and a button. And unlike `clone`'s
//  `--with-content`, a running project cannot be moved AT ALL — PROJECT_RUNNING
//  is a whole-command refusal, not a per-field one — so the disabled-with-a-
//  reason treatment (§11) lands on the panel's one action, not on a control
//  inside it.
//
//  Naming the project's own root is a valid, idempotent CLI call, but not a
//  choice the UI offers: the picker lists every OTHER configured root.
//

import SwiftUI

struct MovePanel: View {
    @EnvironmentObject private var store: BardolierStore

    /// The project being moved. Carried by the panel case, so this is always
    /// about a named project rather than "the selected one".
    var project: String
    var back: () -> Void

    @State private var root: String?

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            PanelHeader(title: "Move \(project)", back: back)

            VStack(alignment: .leading, spacing: 6) {
                Text("Its ports and its files and data move with it — only the folder changes.")
                    .font(.caption2)
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)

                Picker("Root", selection: $root) {
                    ForEach(destinationRoots) { configured in
                        Text(configured.name).tag(Optional(configured.name))
                    }
                }
                .pickerStyle(.menu)
                .disabled(store.isBusy || moveBlockedReason != nil)
                .onAppear { if root == nil { root = destinationRoots.first?.name } }

                if let reason = moveBlockedReason {
                    Text(reason).font(.caption2).foregroundStyle(.orange)
                }
            }
            .padding(.horizontal, 10)

            if let error = store.lastError {
                ErrorBanner(failure: error) { store.clearError() }
            }

            HStack {
                Spacer()
                Button("Cancel", action: back)
                Button("Move") {
                    Task {
                        guard let root else { return }
                        // Closes only on success; a refusal stays here.
                        let done = await store.move(project: project, to: root)
                        if done != nil { back() }
                    }
                }
                .buttonStyle(.borderedProminent)
                .disabled(!canMove)
                .help(moveBlockedReason ?? "Move \(project) to the chosen root.")
            }
            .padding(.horizontal, 10)
            .padding(.bottom, 10)
        }
    }

    private var sourceProject: BardolierProject? {
        store.projects.first { $0.name == project }
    }

    /// Every configured root except the project's own — naming it is a valid,
    /// idempotent CLI call, but not a choice the UI needs to offer (§8.2).
    private var destinationRoots: [ConfiguredRoot] {
        store.roots.filter { $0.name != sourceProject?.root }
    }

    /// `move` refuses PROJECT_RUNNING outright — there is no shape-only escape
    /// hatch the way `clone --with-content` has, so the whole action explains
    /// itself rather than one control inside it (§11).
    private var moveBlockedReason: String? {
        (sourceProject?.state.isUp ?? false) ? "Stop \(project) to move it." : nil
    }

    private var canMove: Bool {
        !store.isBusy && !store.isDegraded && root != nil && moveBlockedReason == nil
    }
}
