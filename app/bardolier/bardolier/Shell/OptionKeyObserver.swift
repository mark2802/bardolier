//
//  OptionKeyObserver.swift
//  Bardolier
//
//  Publishes whether Option is currently held, for the root-shell alternate
//  item (phase 14, docs/development/phases/14-root-shell.md). SwiftUI's `MenuBarExtra`
//  doesn't expose AppKit's native alternate-item mechanism
//  (`NSMenuItem.isAlternate`), so this reimplements the effect with a local
//  event monitor and a state swap in the view instead.
//
//  Scoped to while the menu is open — started/stopped with it via `onAppear`/
//  `onDisappear`, not a permanent global monitor watching keys the rest of the
//  time the app is running.
//

import AppKit
import Combine

@MainActor
final class OptionKeyObserver: ObservableObject {
    @Published private(set) var isOptionHeld = false

    private var monitor: Any?

    func start() {
        guard monitor == nil else { return }
        monitor = NSEvent.addLocalMonitorForEvents(matching: .flagsChanged) { [weak self] event in
            self?.isOptionHeld = event.modifierFlags.contains(.option)
            return event
        }
    }

    func stop() {
        if let monitor {
            NSEvent.removeMonitor(monitor)
        }
        monitor = nil
        isOptionHeld = false
    }

    deinit {
        if let monitor {
            NSEvent.removeMonitor(monitor)
        }
    }
}
