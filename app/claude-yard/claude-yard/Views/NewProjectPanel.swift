//
//  NewProjectPanel.swift
//  Bardolier
//
//  New project (app-spec.md §8).
//
//  Name, archetype, and a checkbox list of catalogue services — the same list
//  the Services submenu ticks, read from `bardolier catalogue` so there is one
//  catalogue and not two (§6, §8).
//
//  The validation here is a COURTESY, not a rule. The CLI is what decides
//  whether a name is usable and whether it collides; this panel only spares the
//  user a round trip for the two cases it can see coming — a name shaped wrong,
//  and a name already listed. If the two ever disagree, the CLI wins: `new`
//  fails with PROJECT_EXISTS or INVALID_ARGUMENT and the error is shown as it
//  came (§13). Nothing here creates anything or assigns a port; ports are the
//  allocator's, and the panel simply reports the ones it was given back (§5).
//

import SwiftUI

struct NewProjectPanel: View {
    @EnvironmentObject private var store: BardolierStore

    var back: () -> Void

    @State private var name = ""
    @State private var archetype: Archetype = .web
    @State private var services: Set<String> = []
    @State private var existingNames: [String] = []

    /// The CLI's own rule (cli/src/commands/new.ts) — mirrored so the field can
    /// say why before the call, never so the app can decide instead.
    private static let namePattern = "^[a-z0-9][a-z0-9._-]*$"

    private static let archetypes: [Archetype] = [.web, .ios, .android, .library]

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            PanelHeader(title: "New project", back: back)

            VStack(alignment: .leading, spacing: 6) {
                TextField("name", text: $name)
                    .textFieldStyle(.roundedBorder)
                    .disabled(store.isBusy)

                if let problem = nameProblem {
                    Text(problem).font(.caption2).foregroundStyle(.orange)
                }

                Picker("Archetype", selection: $archetype) {
                    ForEach(Self.archetypes, id: \.rawValue) { value in
                        Text(value.display).tag(value)
                    }
                }
                .pickerStyle(.menu)
                .disabled(store.isBusy)

                Text("Services").font(.caption2.weight(.semibold)).foregroundStyle(.secondary)
                servicePicker
            }
            .padding(.horizontal, 10)

            if let error = store.lastError {
                ErrorBanner(failure: error) { store.clearError() }
            }

            HStack {
                Spacer()
                Button("Cancel", action: back)
                Button("Create") {
                    Task {
                        // The window closes only on success (§8); a refusal
                        // stays here with the fields still filled in.
                        let trimmed = name.trimmingCharacters(in: .whitespaces)
                        if await store.create(name: trimmed, archetype: archetype, services: services.sorted()) != nil {
                            back()
                        }
                    }
                }
                .buttonStyle(.borderedProminent)
                .disabled(!canCreate)
            }
            .padding(.horizontal, 10)
            .padding(.bottom, 10)
        }
        .task {
            await store.loadCatalogue()
            // §8: the app calls `list` to check for a collision.
            existingNames = await store.projectNames()
        }
    }

    @ViewBuilder
    private var servicePicker: some View {
        if let catalogue = store.catalogue {
            if catalogue.services.isEmpty {
                Text("The catalogue defines none.").font(.caption2).foregroundStyle(.secondary)
            }
            ForEach(catalogue.services) { service in
                Toggle(isOn: binding(for: service.key)) {
                    HStack(spacing: 4) {
                        Text(service.display).font(.caption)
                        Text(service.image).font(.caption2).foregroundStyle(.tertiary)
                    }
                }
                .toggleStyle(.checkbox)
                .disabled(store.isBusy)
            }
        } else if store.lastError == nil {
            Text("Reading the catalogue…").font(.caption2).foregroundStyle(.secondary)
        } else {
            // A catalogue that won't read must not leave a spinner-in-words on
            // screen: a project can still be created without services.
            Text("The catalogue couldn’t be read — you can still create the project and attach services later.")
                .font(.caption2)
                .foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)
        }
    }

    private func binding(for key: String) -> Binding<Bool> {
        Binding(
            get: { services.contains(key) },
            set: { isOn in
                if isOn { services.insert(key) } else { services.remove(key) }
            }
        )
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

    private var canCreate: Bool {
        !store.isBusy
            && !store.isDegraded
            && !name.trimmingCharacters(in: .whitespaces).isEmpty
            && nameProblem == nil
    }
}
