//
//  AppPreferences.swift
//  Bardolier
//
//  The preferences that are genuinely the APP's (app-spec.md §12).
//
//  §12 lists three settings, and only one of them lives here. The SSD path and
//  the terminal belong to the CLI config (`cli-spec.md` §8) so that the CLI and
//  the app cannot disagree about them — Preferences edits those through
//  `bardolier config set` and reads them back from `bardolier config get`. What is left
//  is the one setting the CLI has no opinion about: whether starting a project
//  should also open a shell, which is a fact about this menu, not about the
//  engine.
//
//  The `bardolier` path is here for the same reason — it is where THIS app looks
//  for the binary, which is not something the CLI could tell us.
//

import Combine
import Foundation
import SwiftUI

@MainActor
final class AppPreferences: ObservableObject {
    /// app-spec.md §7: "Start auto-opens a shell by default."
    static let startOpensShellKey = "StartOpensShell"

    private let defaults: UserDefaults

    /// Default ON (§7, §12): a single-project start should drop you straight in.
    @Published var startOpensShell: Bool {
        didSet { defaults.set(startOpensShell, forKey: Self.startOpensShellKey) }
    }

    /// An explicit path to `bardolier`, for installs the search can't guess. Empty
    /// means "search the conventional locations" (BardolierExecutable).
    @Published var bardolierPath: String {
        didSet {
            let trimmed = bardolierPath.trimmingCharacters(in: .whitespacesAndNewlines)
            if trimmed.isEmpty {
                defaults.removeObject(forKey: BardolierExecutable.pathDefaultsKey)
            } else {
                defaults.set(trimmed, forKey: BardolierExecutable.pathDefaultsKey)
            }
        }
    }

    init(defaults: UserDefaults = .standard) {
        self.defaults = defaults
        // `object(forKey:)` rather than `bool(forKey:)`: an unset key reads as
        // false, which would silently invert a preference documented as
        // defaulting to ON.
        self.startOpensShell = defaults.object(forKey: Self.startOpensShellKey) as? Bool ?? true
        self.bardolierPath = defaults.string(forKey: BardolierExecutable.pathDefaultsKey) ?? ""
    }
}
