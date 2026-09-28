//
//  FirstRunPanel.swift
//  Bardolier
//
//  "bardolier isn’t on PATH" (app-spec.md §13).
//
//  This app is a thin client and nothing else: with no `bardolier` to run there is
//  no status to show, no project to start and no disk to eject, so a missing
//  binary is not one command's failure to report in a banner — it is the state
//  of the whole menu. It gets said once, plainly, with the places that were
//  actually searched and the two ways to fix it.
//
//  The searched list comes from `BardolierExecutable`, which is also what did the
//  searching. That is deliberate: a first-run message that lists where the app
//  "probably looked" is how someone ends up installing into a directory the app
//  never consults.
//
//  A GUI app inherits no shell PATH (see BardolierExecutable), so "but it works in
//  my terminal" is the expected report and the panel answers it directly.
//

import AppKit
import SwiftUI

struct FirstRunPanel: View {
    @EnvironmentObject private var store: BardolierStore
    @EnvironmentObject private var preferences: AppPreferences

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(alignment: .top, spacing: 6) {
                Image(systemName: "questionmark.folder").foregroundStyle(.orange)
                VStack(alignment: .leading, spacing: 2) {
                    Text("Can’t find the bardolier command.").font(.caption.weight(.semibold))
                    Text("Everything in this menu runs through it, so nothing works until it’s installed.")
                        .font(.caption2)
                        .foregroundStyle(.secondary)
                        .fixedSize(horizontal: false, vertical: true)
                }
            }

            VStack(alignment: .leading, spacing: 3) {
                Text("Install it").font(.caption2.weight(.semibold)).foregroundStyle(.secondary)
                Text("Run `npm run setup` in the repo. That links bardolier onto \(Self.expectedLocation) (or another directory this app already searches).")
                    .font(.caption2)
                    .foregroundStyle(.secondary)
                    .textSelection(.enabled)
                    .fixedSize(horizontal: false, vertical: true)
            }

            VStack(alignment: .leading, spacing: 3) {
                Text("Or point the app at it").font(.caption2.weight(.semibold)).foregroundStyle(.secondary)
                HStack(spacing: 6) {
                    TextField("/full/path/to/bardolier", text: $preferences.bardolierPath)
                        .textFieldStyle(.roundedBorder)
                        .font(.caption)
                        .onSubmit { recheck() }
                    Button("Choose…", action: choose).controlSize(.small)
                }
                Text("A menu-bar app inherits no shell PATH, so an install somewhere unusual has to be named.")
                    .font(.caption2)
                    .foregroundStyle(.tertiary)
                    .fixedSize(horizontal: false, vertical: true)
            }

            if !store.bardolierSearchedLocations.isEmpty {
                DisclosureGroup {
                    VStack(alignment: .leading, spacing: 1) {
                        ForEach(store.bardolierSearchedLocations, id: \.self) { location in
                            Text(location)
                                .font(.caption2.monospaced())
                                .foregroundStyle(.tertiary)
                                .lineLimit(1)
                                .truncationMode(.head)
                        }
                    }
                    .padding(.top, 2)
                } label: {
                    Text("Where it looked (\(store.bardolierSearchedLocations.count))")
                        .font(.caption2)
                        .foregroundStyle(.secondary)
                }
            }

            Button("Look again", action: recheck)
                .controlSize(.small)
                .disabled(store.isBusy)
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 8)
    }

    /// Where `npm link` puts a global bin on a typical Mac — named so the
    /// instruction above can be checked against reality.
    private static let expectedLocation = "/opt/homebrew/bin/bardolier"

    private func recheck() {
        Task { await store.start() }
    }

    /// A file picker rather than only a text field: the path is long, and the
    /// panel already knows the user is somewhere unusual.
    private func choose() {
        let panel = NSOpenPanel()
        panel.canChooseFiles = true
        panel.canChooseDirectories = false
        panel.allowsMultipleSelection = false
        panel.showsHiddenFiles = true
        panel.prompt = "Use"
        panel.message = "Choose the bardolier executable"
        // An LSUIElement app has no window to be modal to, and the popover
        // gives up focus when the panel opens; activating first is what stops
        // it appearing behind everything.
        NSApp.activate(ignoringOtherApps: true)
        guard panel.runModal() == .OK, let url = panel.url else { return }
        preferences.bardolierPath = url.path
        recheck()
    }
}
