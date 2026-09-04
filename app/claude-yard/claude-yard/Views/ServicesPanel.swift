//
//  ServicesPanel.swift
//  Bardolier
//
//  The Services submenu for one project (app-spec.md §6).
//
//  It lists EVERY service the catalogue defines, ticked where the project has
//  it attached — which is why the app asks `bardolier catalogue` rather than
//  keeping a list of its own. Attached rows show the host port the allocator
//  assigned and a click-to-copy connection string; that port is the debugging
//  tap (cli-spec.md §5), and it is the reason this panel exists at all.
//
//  Two refusals are relayed rather than worked around:
//
//  * A RUNNING project cannot change services. The CLI answers PROJECT_RUNNING
//    and this panel says "Stop the project to change its services" instead of
//    stopping it for you (§6). Add and remove both need the project down, so
//    the whole panel goes read-only rather than half of it.
//  * DETACHING KEEPS THE DATA. The confirmation says so and names the volume;
//    it reappears under Reclaim disk, where deleting it is a separate,
//    deliberate act (§6, §9).
//

import SwiftUI

struct ServicesPanel: View {
    @EnvironmentObject private var store: BardolierStore

    var projectName: String
    var back: () -> Void

    @State private var confirmation: ConfirmationRequest?

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            if let confirmation {
                ConfirmationPanel(request: confirmation) { self.confirmation = nil }
            } else {
                PanelHeader(title: "\(projectName) services", back: back)
                content
            }
        }
        .task { await store.loadCatalogue() }
    }

    @ViewBuilder
    private var content: some View {
        if let project = store.project(named: projectName) {
            if project.state.isUp {
                Text("Stop the project to change its services.")
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .padding(.horizontal, 10)
                    .padding(.bottom, 4)
            }

            if let catalogue = store.catalogue, catalogue.services.isEmpty {
                Text("The catalogue at \(catalogue.path) defines no services.")
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .padding(10)
            } else if let catalogue = store.catalogue {
                ScrollView {
                    VStack(alignment: .leading, spacing: 0) {
                        ForEach(catalogue.services) { service in
                            row(for: service, in: project)
                        }
                    }
                }
                .frame(maxHeight: 320)

                Text("Catalogue: \(catalogue.path)")
                    .font(.caption2)
                    .foregroundStyle(.tertiary)
                    .lineLimit(1)
                    .truncationMode(.middle)
                    .padding(.horizontal, 10)
                    .padding(.vertical, 6)
            } else {
                Text(store.lastError == nil ? "Reading the catalogue…" : "The catalogue couldn’t be read.")
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .padding(10)
            }
        } else {
            Text("That project is no longer there.")
                .font(.caption)
                .foregroundStyle(.secondary)
                .padding(10)
        }

        if let error = store.lastError {
            ErrorBanner(failure: error) { store.clearError() }
                .padding(.bottom, 6)
        }
        if let notice = store.notice {
            NoticeBanner(text: notice) { store.clearNotice() }
                .padding(.bottom, 6)
        }
    }

    /// One catalogue row: ticked when attached, with the assigned port when it
    /// has one and the band it would be assigned from when it doesn't.
    private func row(for service: CatalogueService, in project: BardolierProject) -> some View {
        let attached = project.services.first { $0.key == service.key }
        let canChange = !store.isBusy && !project.state.isUp && !store.isDegraded

        // The copy control sits OUTSIDE the row's button, not inside its
        // label. Inside, it inherited the row's `disabled` — so the connection
        // string became uncopyable exactly while the project was RUNNING,
        // which is when a GUI client needs it (§5, §6).
        return HStack(spacing: 0) {
            MenuRow(isDisabled: !canChange) {
                if let attached {
                    confirmation = detachConfirmation(service: service, attached: attached)
                } else {
                    Task { await store.attach(service: service.key, to: projectName) }
                }
            } content: {
                HStack(spacing: 6) {
                    Image(systemName: attached == nil ? "circle" : "checkmark.circle.fill")
                        .font(.system(size: 11))
                        .foregroundStyle(attached == nil ? Color.secondary : Color.accentColor)
                    VStack(alignment: .leading, spacing: 1) {
                        Text(service.display)
                        if let attached {
                            Text("host :\(String(attached.hostPort)) → :\(String(attached.containerPort))")
                                .font(.caption2.monospaced())
                                .foregroundStyle(.secondary)
                        } else {
                            Text("\(service.image) · band from :\(String(service.hostPortBase))")
                                .font(.caption2)
                                .foregroundStyle(.tertiary)
                        }
                    }
                }
            }
            if let attached {
                CopyButton(value: attached.connectionHint, help: "Copy \(attached.connectionHint)")
                    .padding(.trailing, 10)
            }
        }
    }

    private func detachConfirmation(service: CatalogueService, attached: ProjectService) -> ConfirmationRequest {
        ConfirmationRequest(
            title: "Detach \(service.display) from \(projectName)?",
            detail: "Host port \(attached.hostPort) is released and the compose file is regenerated. "
                + "The data volume is KEPT — it appears under Reclaim disk until you delete it.",
            confirmLabel: "Detach",
            toggleLabel: nil,
            perform: { _ in
                Task { await store.detach(service: service.key, from: projectName) }
            }
        )
    }
}
