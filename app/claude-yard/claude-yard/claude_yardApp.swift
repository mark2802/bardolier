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
//  `.window` style rather than `.menu`: Phase 5's job is to show a decoded
//  status dump, which wants a real view. Phase 6 replaces the content with the
//  menu of §5 — the scene stays as it is.
//

import SwiftUI

@main
struct claude_yardApp: App {
    @StateObject private var store = CprojStore()

    var body: some Scene {
        MenuBarExtra {
            DebugStatusView()
                .environmentObject(store)
        } label: {
            // Icon state derives purely from the latest status/doctor (§11).
            Image(systemName: store.iconSymbol)
        }
        .menuBarExtraStyle(.window)
    }
}
