//
//  claude_yardApp.swift
//  claude-yard
//
//  Created by Mark Williams on 24/08/2026.
//
//  A menu-bar-only app (app-spec.md §1): `MenuBarExtra`, no dock icon, no
//  window. `LSUIElement` = YES and App Sandbox OFF are BUILD SETTINGS, not
//  code — the sandbox would block shelling out to `cproj`, which is the app's
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
struct claude_yardApp: App {
    @StateObject private var store = CprojStore()
    @StateObject private var preferences = AppPreferences()

    var body: some Scene {
        MenuBarExtra {
            MenuBarRootView()
                .environmentObject(store)
                .environmentObject(preferences)
        } label: {
            // Icon state derives purely from the latest status/doctor (§11).
            Image(systemName: store.iconSymbol)
        }
        .menuBarExtraStyle(.window)
    }
}
