//
//  ClonePanel.swift
//  Bardolier
//
//  Clone a project (app-spec.md §8.1).
//
//  `NewProjectPanel` with one field fewer and one checkbox more: a clone takes
//  its archetype, services and packages from its source (cli-spec.md §4.2), so
//  there is nothing to pick. What is left is the new name, which root it lands
//  in, and whether the content travels.
//
//  The validation here is the same COURTESY `NewProjectPanel` offers — the CLI
//  decides whether a name is usable and whether it collides, and its refusal is
//  what the user sees if the two ever disagree (§13).
//
//  `--with-content` copies all four folders of cli-spec.md §3, the container's
//  home included — a clone means an identical copy. It is the one
//  state-dependent control: the CLI refuses it on a running project
//  (PROJECT_RUNNING) and a shape clone of that same project succeeds, so a
//  running source disables the CHECKBOX rather than the panel, and says why
//  (§11). Nothing here stops the project to make it available.
//

import SwiftUI

struct ClonePanel: View {
    @EnvironmentObject private var store: BardolierStore

    /// The project being cloned. Carried by the panel case, so this is always
    /// about a named project rather than "the selected one".
    var source: String
    var back: () -> Void

    @State private var name = ""
    @State private var withContent = false
    @State private var existingNames: [String] = []
    /// nil means "the CLI's own default" — which for `clone` is the SOURCE's
    /// root, not the first configured one.
    @State private var root: String?

    /// The CLI's own rule (cli/src/commands/new.ts), mirrored so the field can
    /// say why before the call, never so the app can decide instead.
    private static let namePattern = "^[a-z0-9][a-z0-9._-]*$"

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            PanelHeader(title: "Clone \(source)", back: back)

            VStack(alignment: .leading, spacing: 6) {
                TextField("new name", text: $name)
                    .textFieldStyle(.roundedBorder)
                    .disabled(store.isBusy)

                if let problem = nameProblem {
                    Text(problem).font(.caption2).foregroundStyle(.orange)
                }

                Text("Same archetype, services, extra ports and packages — with its own host ports.")
                    .font(.caption2)
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)

                rootPicker

                contentToggle
            }
            .padding(.horizontal, 10)

            if let error = store.lastError {
                ErrorBanner(failure: error) { store.clearError() }
            }

            HStack {
                Spacer()
                Button("Cancel", action: back)
                Button("Clone") {
                    Task {
                        // Closes only on success; a refusal stays here with the
                        // fields still filled in.
                        let trimmed = name.trimmingCharacters(in: .whitespaces)
                        let done = await store.clone(
                            source: source,
                            name: trimmed,
                            root: root,
                            withContent: withContent && canCopyContent
                        )
                        if done != nil { back() }
                    }
                }
                .buttonStyle(.borderedProminent)
                .disabled(!canClone)
            }
            .padding(.horizontal, 10)
            .padding(.bottom, 10)
        }
        .task {
            existingNames = await store.projectNames()
        }
    }

    /// Only shown with more than one configured root. Left nil in the
    /// common case so the CLI's own default — the source's root — applies.
    @ViewBuilder
    private var rootPicker: some View {
        if store.roots.count > 1 {
            Picker("Root", selection: $root) {
                ForEach(store.roots) { configured in
                    Text(configured.name).tag(Optional(configured.name))
                }
            }
            .pickerStyle(.menu)
            .disabled(store.isBusy)
            .onAppear { if root == nil { root = sourceRoot ?? store.roots.first?.name } }
        }
    }

    /// The copy toggle and, when it is inert, the reason — a dimmed control with
    /// no explanation is indistinguishable from a broken one (§11).
    @ViewBuilder
    private var contentToggle: some View {
        Toggle(isOn: $withContent) {
            Text("Also copy its files and data").font(.caption)
        }
        .toggleStyle(.checkbox)
        .disabled(store.isBusy || !canCopyContent)
        .help(contentBlockedReason ?? "Copies work/, data/, local/ and home/ byte-for-byte.")

        Text(contentBlockedReason ?? "An identical copy — work/, data/, local/ and the container’s home.")
            .font(.caption2)
            .foregroundStyle(canCopyContent ? Color.secondary : Color.orange)
            .fixedSize(horizontal: false, vertical: true)
    }

    private var sourceProject: BardolierProject? {
        store.projects.first { $0.name == source }
    }

    private var sourceRoot: String? {
        sourceProject?.root
    }

    /// The CLI's precondition, mirrored: content can only be copied from a
    /// stopped project, because a `data/` copied out from under a running
    /// Postgres is a torn one.
    private var canCopyContent: Bool {
        sourceProject.map { !$0.state.isUp } ?? true
    }

    private var contentBlockedReason: String? {
        canCopyContent ? nil : "Stop \(source) to copy its files and data. Cloning its shape works either way."
    }

    /// What is wrong with the name as typed, or nil when nothing visibly is.
    private var nameProblem: String? {
        let trimmed = name.trimmingCharacters(in: .whitespaces)
        if trimmed.isEmpty { return nil }
        if trimmed.range(of: Self.namePattern, options: .regularExpression) == nil {
            return "Lower-case letters, digits, dot, dash or underscore; start with a letter or digit."
        }
        if existingNames.contains(trimmed) { return "A project called \(trimmed) already exists." }
        return nil
    }

    private var canClone: Bool {
        !store.isBusy
            && !store.isDegraded
            && !name.trimmingCharacters(in: .whitespaces).isEmpty
            && nameProblem == nil
    }
}
