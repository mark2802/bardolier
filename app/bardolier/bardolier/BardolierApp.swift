//
//  BardolierApp.swift
//  Bardolier
//
//  Created by Mark Williams on 24/08/2026.
//
//  A menu-bar-only app (app-spec.md §1): `MenuBarExtra`, no dock icon, no
//  window. `LSUIElement` = YES and App Sandbox OFF are BUILD SETTINGS, not
//  code — the sandbox would block shelling out to `bardolier`, which is the app's
//  only way of doing anything. See app/README.md.
//
//  `.window` style rather than `.menu`: the menu needs a refresh on open, a
//  visible activity state while a command runs, and inline confirmations for
//  destructive actions — see MenuChrome.swift for why an AppKit menu makes all
//  three awkward.
//
//  Two objects live for the app's lifetime: the store (what the CLI last said)
//  and the preferences (the one setting that is genuinely the app's). Both are
//  handed to every panel through the environment.
//

import SwiftUI

@main
struct BardolierApp: App {
    @StateObject private var store = BardolierStore()
    @StateObject private var preferences = AppPreferences()

    var body: some Scene {
        MenuBarExtra {
            MenuBarRootView()
                .environmentObject(store)
                .environmentObject(preferences)
        } label: {
            // Icon state derives purely from the latest status/doctor (§11).
            MenuBarIconView(icon: store.menuBarIcon)
        }
        .menuBarExtraStyle(.window)
    }
}

/// Renders `MenuBarIcon`: one base glyph at every state, a small corner badge,
/// and a pulse while busy — never a different pictogram per state (§11). The
/// badge is deliberately tiny and off to the side, so from arm's length the
/// icon is unmistakably the same shape it always is; up close it also says why.
private struct MenuBarIconView: View {
    let icon: MenuBarIcon

    /// Driven by hand rather than `.symbolEffect(.pulse, isActive:)`: that
    /// modifier's own animation loop did not visibly play inside a
    /// `MenuBarExtra` label (the status item's button doesn't reliably keep a
    /// symbol effect's Core Animation running the way an ordinary view does).
    /// A plain opacity toggle, driven by our own timer, forces a genuine
    /// SwiftUI re-render every tick and has no such dependency.
    @State private var dimmed = false

    var body: some View {
        Image(systemName: icon.filled ? "shippingbox.fill" : "shippingbox")
            .opacity(icon.animated && dimmed ? 0.35 : 1)
            .overlay(alignment: .bottomTrailing) {
                if let badge = icon.badge {
                    Image(systemName: badge == .warning ? "exclamationmark.circle.fill" : "checkmark.circle.fill")
                        .symbolRenderingMode(.palette)
                        .foregroundStyle(.white, badge == .warning ? Color.orange : Color.green)
                        .font(.system(size: 8))
                        .offset(x: 4, y: 3)
                }
            }
            // Restarts (and its predecessor cancels) whenever `animated`
            // flips — `.task(id:)`'s own mechanism, not a flag this checks.
            .task(id: icon.animated) {
                guard icon.animated else { dimmed = false; return }
                while !Task.isCancelled {
                    withAnimation(.easeInOut(duration: 0.6)) { dimmed.toggle() }
                    try? await Task.sleep(nanoseconds: 600_000_000)
                }
            }
    }
}
