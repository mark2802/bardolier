//
//  MenuChrome.swift
//  claude-yard
//
//  The parts every panel of the menu is built from (app-spec.md §5).
//
//  The menu is a `MenuBarExtra` in `.window` style rather than `.menu`, so
//  these are SwiftUI views rather than `Menu` items. That choice buys the three
//  things §4 and §11 ask for and an AppKit menu makes awkward: a refresh on
//  open (`onAppear` fires), a visible activity state while a command runs, and
//  an inline confirmation for destructive actions — a sheet or alert over a
//  menu-bar popover fights the popover's dismissal, and a confirmation the user
//  can lose by looking away is worse than no confirmation at all (§6, §9).
//
//  Nothing here talks to the CLI or decides anything. These are shapes.
//

import AppKit
import SwiftUI

/// Popover width. Wide enough for `postgresql://localhost:5433` unwrapped —
/// the connection string is the debugging payoff (§5) and must be readable.
let menuWidth: CGFloat = 320

/// A row that behaves like a menu item: full-width, highlights on hover,
/// dimmed and inert when disabled.
struct MenuRow<Content: View>: View {
    var systemImage: String?
    var isDisabled = false
    /// Why this row is inert, shown on hover (§11). A disabled item with no
    /// explanation is indistinguishable from a missing one — which is exactly
    /// how "Delete…" came to look absent while Docker was simply not running.
    var disabledReason: String?
    var action: () -> Void
    @ViewBuilder var content: () -> Content

    @State private var isHovering = false

    var body: some View {
        Button(action: action) {
            HStack(spacing: 8) {
                if let systemImage {
                    Image(systemName: systemImage)
                        .frame(width: 14)
                        .foregroundStyle(.secondary)
                }
                content()
                Spacer(minLength: 0)
            }
            .padding(.horizontal, 10)
            .padding(.vertical, 5)
            .contentShape(Rectangle())
            .background(
                RoundedRectangle(cornerRadius: 5)
                    .fill(isHovering && !isDisabled ? Color.accentColor.opacity(0.18) : Color.clear)
            )
        }
        .buttonStyle(.plain)
        .disabled(isDisabled)
        .opacity(isDisabled ? 0.45 : 1)
        .onHover { isHovering = $0 }
        // On the container rather than the Button: a disabled control does not
        // reliably serve its own help tag.
        .help(isDisabled ? (disabledReason ?? "") : "")
    }
}

/// One line saying why the actions above or below it are inert (§11).
///
/// Shown ONCE per group rather than on every row: with the SSD away or Docker
/// down every mutating item is disabled at the same time and for the same
/// reason, and repeating it against each one would be noise rather than help.
struct DisabledNotice: View {
    var reason: String

    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: 5) {
            Image(systemName: "info.circle")
                .font(.system(size: 9))
            Text(reason)
                .font(.caption2)
                .fixedSize(horizontal: false, vertical: true)
        }
        .foregroundStyle(.secondary)
        .padding(.horizontal, 10)
        .padding(.vertical, 3)
    }
}

/// A plain text menu row — the common case.
struct MenuTextRow: View {
    var title: String
    var systemImage: String?
    var isDisabled = false
    var disabledReason: String?
    var action: () -> Void

    var body: some View {
        MenuRow(systemImage: systemImage, isDisabled: isDisabled, disabledReason: disabledReason, action: action) {
            Text(title)
        }
    }
}

/// Section label, e.g. "Projects".
struct MenuSectionHeader: View {
    var title: String

    var body: some View {
        Text(title.uppercased())
            .font(.caption2.weight(.semibold))
            .foregroundStyle(.secondary)
            .padding(.horizontal, 10)
            .padding(.top, 6)
            .padding(.bottom, 2)
            .frame(maxWidth: .infinity, alignment: .leading)
    }
}

/// Green = running, grey = stopped, half = partial (§5). The one place project
/// state becomes a colour.
struct StateDot: View {
    var state: ProjectState

    var body: some View {
        Image(systemName: symbol)
            .font(.system(size: 9))
            .foregroundStyle(tint)
    }

    private var symbol: String {
        switch state {
        case .running: return "circle.fill"
        case .partial: return "circle.lefthalf.filled"
        default: return "circle"
        }
    }

    private var tint: Color {
        switch state {
        case .running: return .green
        case .partial: return .orange
        default: return .secondary
        }
    }
}

/// The header a sub-panel gets: back to the menu, plus a title.
struct PanelHeader: View {
    var title: String
    var back: () -> Void

    var body: some View {
        HStack(spacing: 6) {
            Button(action: back) {
                Image(systemName: "chevron.left")
                    .font(.system(size: 11, weight: .semibold))
            }
            .buttonStyle(.plain)
            .help("Back to the menu")

            Text(title).font(.headline)
            Spacer()
        }
        .padding(.horizontal, 10)
        .padding(.top, 8)
        .padding(.bottom, 4)
    }
}

/// The last action's result — an assigned host port, a reclaimed size (§6, §9).
struct NoticeBanner: View {
    var text: String
    var dismiss: () -> Void

    var body: some View {
        HStack(alignment: .top, spacing: 6) {
            Image(systemName: "checkmark.circle.fill").foregroundStyle(.green)
            Text(text).font(.caption).textSelection(.enabled)
            Spacer(minLength: 0)
            Button(action: dismiss) {
                Image(systemName: "xmark").font(.system(size: 9))
            }
            .buttonStyle(.plain)
            .foregroundStyle(.secondary)
        }
        .padding(8)
        .background(RoundedRectangle(cornerRadius: 6).fill(Color.green.opacity(0.12)))
        .padding(.horizontal, 8)
    }
}

/// A failure, in the words §13 asks for: the short message for the code, the
/// CLI's own sentence underneath, and a recovery line when there is one. Never
/// a stack trace, never a raw decoding error.
struct ErrorBanner: View {
    var failure: CprojFailure
    var dismiss: () -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack(alignment: .top, spacing: 6) {
                Image(systemName: "exclamationmark.triangle.fill").foregroundStyle(.orange)
                Text(failure.errorDescription ?? "Something went wrong.")
                    .font(.caption.weight(.medium))
                    .textSelection(.enabled)
                Spacer(minLength: 0)
                Button(action: dismiss) {
                    Image(systemName: "xmark").font(.system(size: 9))
                }
                .buttonStyle(.plain)
                .foregroundStyle(.secondary)
            }

            // The CLI's own message, when it says more than the short one.
            if let reason = failure.failureReason, reason != failure.errorDescription {
                Text(reason)
                    .font(.caption2)
                    .foregroundStyle(.secondary)
                    .textSelection(.enabled)
            }

            // EJECT_BLOCKED's holders (§10): who to quit, by name. The same
            // rows the eject panel shows, so a holder reads identically
            // wherever it surfaces.
            if !failure.holders.isEmpty {
                HolderList(holders: failure.holders)
            }

            if let suggestion = failure.recoverySuggestion {
                Text(suggestion)
                    .font(.caption2)
                    .foregroundStyle(.secondary)
                    .textSelection(.enabled)
            }
        }
        .padding(8)
        .background(RoundedRectangle(cornerRadius: 6).fill(Color.orange.opacity(0.12)))
        .padding(.horizontal, 8)
    }
}

/// What the app must ask before a destructive call, because the CLI can't:
/// under `--json` it refuses to prompt, and the client passes `--force`
/// (app-spec.md §6, §9).
struct ConfirmationRequest: Identifiable {
    let id = UUID()
    var title: String
    var detail: String
    var confirmLabel: String
    /// An extra choice, e.g. "Also delete its data volumes" on project delete.
    var toggleLabel: String?
    var perform: (Bool) -> Void
}

struct ConfirmationPanel: View {
    var request: ConfirmationRequest
    /// Closes the panel. Called for Cancel AND before Confirm — a confirmation
    /// that stayed on screen while the action ran would invite a second click.
    var dismiss: () -> Void

    @State private var toggle = false

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text(request.title).font(.headline)
            Text(request.detail)
                .font(.caption)
                .foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)

            if let toggleLabel = request.toggleLabel {
                Toggle(toggleLabel, isOn: $toggle)
                    .font(.caption)
                    .toggleStyle(.checkbox)
            }

            HStack {
                Spacer()
                Button("Cancel", action: dismiss)
                Button(request.confirmLabel) {
                    dismiss()
                    request.perform(toggle)
                }
                    .buttonStyle(.borderedProminent)
                    .tint(.red)
            }
        }
        .padding(12)
    }
}

/// Click to copy — the connection string is the whole reason a host port is
/// published (§5, §6).
struct CopyButton: View {
    var value: String
    var help: String

    @State private var copied = false

    var body: some View {
        Button {
            NSPasteboard.general.clearContents()
            NSPasteboard.general.setString(value, forType: .string)
            copied = true
            Task {
                try? await Task.sleep(nanoseconds: 1_200_000_000)
                copied = false
            }
        } label: {
            Image(systemName: copied ? "checkmark" : "doc.on.doc")
                .font(.system(size: 10))
                .foregroundStyle(copied ? Color.green : Color.secondary)
        }
        .buttonStyle(.plain)
        .help(help)
    }
}

/// Who still holds the SSD (app-spec.md §10).
///
/// The CLI's answer, rendered and not interpreted: `lsof` named a command, a
/// pid, the user and the paths, and the app's whole job is to make "quit Xcode"
/// the obvious next move. It never offers to kill anything — cproj will not
/// force an unmount, and neither will the menu that drives it.
struct HolderList: View {
    var holders: [SsdHolder]

    var body: some View {
        VStack(alignment: .leading, spacing: 3) {
            ForEach(holders) { holder in
                VStack(alignment: .leading, spacing: 1) {
                    HStack(spacing: 4) {
                        Image(systemName: "macwindow")
                            .font(.system(size: 9))
                            .foregroundStyle(.secondary)
                        Text(holder.command).font(.caption.weight(.medium))
                        Text("pid \(String(holder.pid))\(holder.user.map { " · \($0)" } ?? "")")
                            .font(.caption2.monospaced())
                            .foregroundStyle(.secondary)
                    }
                    // One path is enough to recognise WHY it is holding the
                    // disk; the CLI already limits how many it reports.
                    if let path = holder.paths.first {
                        Text(path)
                            .font(.caption2)
                            .foregroundStyle(.tertiary)
                            .lineLimit(1)
                            .truncationMode(.head)
                    }
                }
            }
        }
    }
}

/// A menu row whose whole width copies a value — the click-to-copy §5 asks for.
///
/// The icon is FEEDBACK, not the target. A 10pt button is a poor thing to aim
/// at when the connection string is the reason the row exists, so the row takes
/// the click and the icon only says it landed.
struct CopyRow<Content: View>: View {
    var value: String
    var help: String
    @ViewBuilder var content: () -> Content

    @State private var copied = false

    var body: some View {
        MenuRow(action: copy) {
            HStack(spacing: 6) {
                content()
                Spacer(minLength: 0)
                Image(systemName: copied ? "checkmark" : "doc.on.doc")
                    .font(.system(size: 10))
                    .foregroundStyle(copied ? Color.green : Color.secondary)
            }
        }
        .help(help)
    }

    private func copy() {
        NSPasteboard.general.clearContents()
        NSPasteboard.general.setString(value, forType: .string)
        copied = true
        Task {
            try? await Task.sleep(nanoseconds: 1_200_000_000)
            copied = false
        }
    }
}

/// Reveal a path in Finder (§5). `NSWorkspace`, not a process — and the path
/// comes from `status`, never composed here.
@MainActor
func revealInFinder(_ path: String) {
    NSWorkspace.shared.activateFileViewerSelecting([URL(fileURLWithPath: path)])
}
