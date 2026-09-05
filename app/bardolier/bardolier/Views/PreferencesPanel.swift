//
//  PreferencesPanel.swift
//  Bardolier
//
//  Preferences (app-spec.md §12).
//
//  Three kinds of setting, and only two are the app's own. Roots and the
//  terminal are written to the CLI CONFIG — roots through `bardolier root
//  add|remove` (list-valued, so `config set` cannot touch them, phase 18),
//  the terminal through `bardolier config set` — so that the CLI and the menu
//  can never disagree about where projects live or what a shell opens in
//  (§12: "written to the CLI config so there is one source"). The auto-shell
//  toggle is genuinely local — the CLI has no opinion about whether starting
//  a project should also open a window.
//
//  The `bardolier` path is here too, because a GUI app inherits no shell PATH and
//  a fresh install can otherwise leave the menu with nothing to talk to (§13,
//  the first-run message).
//
//  When the environment overrides a setting (`$BARDOLIER_ROOT` replaces the
//  whole roots list), the panel says so — a preference that appears to save
//  and then does nothing is worse than one that explains itself.
//

import AppKit
import SwiftUI

struct PreferencesPanel: View {
    @EnvironmentObject private var store: BardolierStore
    @EnvironmentObject private var preferences: AppPreferences

    var back: () -> Void

    @State private var newRootPath = ""
    @State private var newRootName = ""
    @State private var terminal = BardolierTerminal.fallbackName
    @State private var customTerminal = ""

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            PanelHeader(title: "Preferences", back: back)

            ScrollView {
                VStack(alignment: .leading, spacing: 12) {
                    rootsSection
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

    // MARK: - Roots (§8, §12 — written through `root add|remove`, phase 18)

    private var rootsSection: some View {
        VStack(alignment: .leading, spacing: 4) {
            Text("Roots").font(.caption.weight(.semibold))

            ForEach(store.roots) { root in
                HStack(spacing: 6) {
                    Text(root.name).font(.caption).fontWeight(.medium)
                    Text(root.path).font(.caption2).foregroundStyle(.secondary).lineLimit(1).truncationMode(.middle)
                    if !root.mounted {
                        Text("not readable").font(.caption2).foregroundStyle(.orange)
                    }
                    Spacer()
                    Button("Forget") { Task { await store.removeRoot(name: root.name) } }
                        .controlSize(.small)
                        .disabled(store.isBusy)
                }
            }
            Text("The first root is where New Project creates a project by default. Forgetting a root never touches its directory.")
                .font(.caption2).foregroundStyle(.tertiary)

            HStack(spacing: 6) {
                TextField("Path, e.g. /Volumes/ssd/claude-projects", text: $newRootPath)
                    .textFieldStyle(.roundedBorder)
                    .font(.caption)
                    .disabled(store.isBusy)
                Button("Choose…", action: choosePath)
                    .controlSize(.small)
                    .disabled(store.isBusy)
                TextField("Name (optional)", text: $newRootName)
                    .textFieldStyle(.roundedBorder)
                    .font(.caption)
                    .frame(width: 90)
                    .disabled(store.isBusy)
                Button("Add") {
                    let path = newRootPath
                    let name = newRootName.isEmpty ? nil : newRootName
                    newRootPath = ""
                    newRootName = ""
                    Task { await store.addRoot(path: path, name: name) }
                }
                .controlSize(.small)
                .disabled(store.isBusy || newRootPath.isEmpty)
            }

            if store.cliConfig?.overrides.contains("BARDOLIER_ROOT") == true {
                Text("$BARDOLIER_ROOT is set right now and replaces this whole list.")
                    .font(.caption2)
                    .foregroundStyle(.orange)
            }
        }
    }

    /// A folder picker rather than only a text field: a root's path is long,
    /// often on a disk the user just plugged in, and `root add` can point at
    /// a folder that doesn't exist yet — `diskutil` mounts the volume,
    /// `root add` never creates the directory itself, so the panel is what
    /// offers "New Folder" (phase 18).
    private func choosePath() {
        let panel = NSOpenPanel()
        panel.canChooseFiles = false
        panel.canChooseDirectories = true
        panel.canCreateDirectories = true
        panel.allowsMultipleSelection = false
        panel.prompt = "Use"
        panel.message = "Choose or create a projects folder"
        // An LSUIElement app has no window to be modal to, and the popover
        // gives up focus when the panel opens; activating first is what stops
        // it appearing behind everything (mirrors FirstRunPanel.choose()).
        NSApp.activate(ignoringOtherApps: true)
        guard panel.runModal() == .OK, let url = panel.url else { return }
        newRootPath = url.path
        // "Default the name to the drive": a courtesy prefill, not a
        // decision — `root add` derives its own default from the path's
        // basename when the field is left blank, and validates whatever
        // ends up here regardless (cli/src/config.ts's `isValidRootName`).
        if let volumeName = try? url.resourceValues(forKeys: [.volumeNameKey]).volumeName {
            newRootName = Self.sanitizedRootName(volumeName)
        }
    }

    /// Mirrors `nameFromPath`'s sanitizing (cli/src/config.ts): letters,
    /// digits, dot, dash, underscore, starting with a letter or digit — so
    /// the prefill is usually accepted outright rather than bounced back by
    /// `root add`'s own validation.
    private static func sanitizedRootName(_ raw: String) -> String {
        var sanitized = raw.map { $0.isLetter || $0.isNumber || $0 == "." || $0 == "-" || $0 == "_" ? $0 : "-" }
        while let first = sanitized.first, first == "." || first == "-" || first == "_" { sanitized.removeFirst() }
        return sanitized.isEmpty ? "root" : String(sanitized)
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
