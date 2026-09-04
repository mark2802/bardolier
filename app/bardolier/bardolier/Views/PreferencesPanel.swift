//
//  PreferencesPanel.swift
//  Bardolier
//
//  Preferences (app-spec.md §12).
//
//  Three settings, and only one of them is the app's. The SSD path and the
//  terminal are written to the CLI CONFIG through `bardolier config set`, so that
//  the CLI and the menu can never disagree about where the disk is or what a
//  shell opens in (§12: "written to the CLI config so there is one source").
//  The auto-shell toggle is genuinely local — the CLI has no opinion about
//  whether starting a project should also open a window.
//
//  The `bardolier` path is here too, because a GUI app inherits no shell PATH and
//  a fresh install can otherwise leave the menu with nothing to talk to (§13,
//  the first-run message).
//
//  When the environment overrides a key (`$BDLR_SSD_ROOT`), the write still
//  happens but the panel says the environment wins — a preference that appears
//  to save and then does nothing is worse than one that explains itself.
//

import SwiftUI

struct PreferencesPanel: View {
    @EnvironmentObject private var store: BardolierStore
    @EnvironmentObject private var preferences: AppPreferences

    var back: () -> Void

    @State private var ssdVolume = ""
    @State private var ssdRoot = ""
    @State private var terminal = BardolierTerminal.fallbackName
    @State private var customTerminal = ""

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            PanelHeader(title: "Preferences", back: back)

            ScrollView {
                VStack(alignment: .leading, spacing: 12) {
                    ssdSection
                    Divider()
                    terminalSection
                    Divider()
                    cliSection
                }
                .padding(.horizontal, 10)
            }
            .frame(maxHeight: 380)

            if let error = store.lastError {
                ErrorBanner(failure: error) { store.clearError() }
            }
            if let notice = store.notice {
                NoticeBanner(text: notice) { store.clearNotice() }
            }
        }
        .padding(.bottom, 10)
        .task {
            await store.loadConfig()
            syncFromConfig()
        }
    }

    // MARK: - SSD (§12, written to the CLI config)

    private var ssdSection: some View {
        VStack(alignment: .leading, spacing: 4) {
            Text("SSD").font(.caption.weight(.semibold))

            field("Volume", text: $ssdVolume, placeholder: "/Volumes/ssd", key: .ssdVolume)
            Text("The disk itself — what Close all & eject unmounts.")
                .font(.caption2).foregroundStyle(.tertiary)

            field("Projects", text: $ssdRoot, placeholder: "/Volumes/ssd/claude-projects", key: .ssdRoot)
            Text("Where project folders live. Leave it matching the volume unless you moved them.")
                .font(.caption2).foregroundStyle(.tertiary)

            if !overrides.isEmpty {
                Text("Set by the environment right now: \(overrides.joined(separator: ", ")). Those win over this file.")
                    .font(.caption2)
                    .foregroundStyle(.orange)
            }
        }
    }

    /// A config-backed text field with its own Save — one write per key, so the
    /// CLI's answer for that key is what comes back.
    private func field(_ label: String, text: Binding<String>, placeholder: String, key: ConfigKey) -> some View {
        HStack(spacing: 6) {
            Text(label).font(.caption).frame(width: 60, alignment: .leading)
            TextField(placeholder, text: text)
                .textFieldStyle(.roundedBorder)
                .font(.caption)
                .disabled(store.isBusy)
                .onSubmit { save(key, text.wrappedValue) }
            Button("Save") { save(key, text.wrappedValue) }
                .controlSize(.small)
                .disabled(store.isBusy)
        }
    }

    // MARK: - Terminal (§7, §12)

    private var terminalSection: some View {
        VStack(alignment: .leading, spacing: 4) {
            Text("Shell").font(.caption.weight(.semibold))

            Picker("Terminal", selection: $terminal) {
                ForEach(terminalChoices, id: \.self) { name in
                    Text(name).tag(name)
                }
                Text("Other…").tag(Self.otherTerminal)
            }
            .pickerStyle(.menu)
            .font(.caption)
            .disabled(store.isBusy)
            .onChange(of: terminal) { _, value in
                if value != Self.otherTerminal { save(.terminal, value) }
            }

            if terminal == Self.otherTerminal {
                HStack(spacing: 6) {
                    TextField("App name, e.g. Warp", text: $customTerminal)
                        .textFieldStyle(.roundedBorder)
                        .font(.caption)
                        .onSubmit { save(.terminal, customTerminal) }
                    Button("Save") { save(.terminal, customTerminal) }
                        .controlSize(.small)
                }
            }

            if !BardolierTerminal.isScriptable(effectiveTerminal) {
                Text("\(effectiveTerminal) isn’t scriptable, so shells open through a `.command` file. "
                    + "Terminal and iTerm are driven directly.")
                    .font(.caption2)
                    .foregroundStyle(.tertiary)
            }

            Toggle("Starting a project opens a shell", isOn: $preferences.startOpensShell)
                .toggleStyle(.checkbox)
                .font(.caption)
        }
    }

    // MARK: - The CLI itself (§13)

    private var cliSection: some View {
        VStack(alignment: .leading, spacing: 4) {
            Text("bardolier").font(.caption.weight(.semibold))

            HStack(spacing: 6) {
                Text("Path").font(.caption).frame(width: 60, alignment: .leading)
                TextField(store.executablePath ?? "not found", text: $preferences.bardolierPath)
                    .textFieldStyle(.roundedBorder)
                    .font(.caption)
                Button("Recheck") {
                    Task { await store.refresh(force: true) }
                }
                .controlSize(.small)
                .disabled(store.isBusy)
            }
            Text(store.executablePath.map { "Using \($0)" } ?? "Leave blank to search the usual places.")
                .font(.caption2)
                .foregroundStyle(.tertiary)
                .lineLimit(1)
                .truncationMode(.middle)

            if let config = store.cliConfig {
                Text("Config: \(config.path)\(config.exists ? "" : " (not written yet)")")
                    .font(.caption2)
                    .foregroundStyle(.tertiary)
                    .lineLimit(1)
                    .truncationMode(.middle)
            }
            if let catalogue = store.catalogue {
                Text("Catalogue: \(catalogue.path) (\(catalogue.origin.rawValue))")
                    .font(.caption2)
                    .foregroundStyle(.tertiary)
                    .lineLimit(1)
                    .truncationMode(.middle)
            }
        }
    }

    // MARK: - Plumbing

    private static let otherTerminal = "__other__"

    private var overrides: [String] { store.cliConfig?.overrides ?? [] }

    private var terminalChoices: [String] {
        var names = BardolierTerminal.suggested
        let current = store.terminalName
        if !names.contains(current) && current != Self.otherTerminal { names.append(current) }
        return names
    }

    private var effectiveTerminal: String {
        terminal == Self.otherTerminal ? customTerminal : terminal
    }

    private func syncFromConfig() {
        guard let config = store.cliConfig?.config else { return }
        ssdVolume = config.ssdVolume
        ssdRoot = config.ssdRoot
        terminal = config.terminal
        customTerminal = config.terminal
    }

    private func save(_ key: ConfigKey, _ value: String) {
        Task {
            await store.setConfig(key, to: value)
            syncFromConfig()
        }
    }
}
