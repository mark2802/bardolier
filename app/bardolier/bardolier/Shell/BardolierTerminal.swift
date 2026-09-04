//
//  BardolierTerminal.swift
//  Bardolier
//
//  Opening a shell (app-spec.md §7).
//
//  The division of labour is the whole point: `bardolier shell <name> --json`
//  RESOLVES the dev container and returns the exec argv; the CLI spawns no
//  terminal. This file spawns the terminal and runs exactly that argv. It
//  decides nothing about containers — it does not know what `docker exec` is,
//  only that it was handed a command and told which app should run it.
//
//  It also launches no process of its own. `BardolierClient` is the only thing in
//  this app that may construct a `Process` (test/app-models.test.ts enforces
//  it), and there is a good reason beyond tidiness: a helper process spawned
//  here would inherit this app's environment and none of the terminal's, so
//  the shell the user landed in would behave unlike every other shell on their
//  Mac. Handing the command to the terminal APP means the user's own profile,
//  PATH and window settings apply.
//
//  Two ways to do that, and which one is used depends on the terminal:
//
//  * Terminal and iTerm are scriptable and documented, so they get AppleScript
//    (`do script` / `create window … command`) — the command lands in a normal
//    window of theirs.
//  * Anything else gets an executable `.command` file opened with that app.
//    Best-effort by design: the terminal the user chose might not handle one,
//    and if it doesn't, that is reported plainly rather than papered over.
//
//  AppleScript driving another app needs the Automation permission, which macOS
//  asks for the first time and which requires NSAppleEventsUsageDescription in
//  the built app (a BUILD SETTING — see app/README.md).
//

import AppKit
import Foundation

/// Something went wrong on this side of the seam — the CLI answered fine, the
/// terminal is what wouldn't play. Kept apart from `BardolierFailure` so a shell
/// that won't open is never mistaken for a container that won't start.
nonisolated struct TerminalFailure: Error {
    let message: String
    /// True when macOS refused the Apple event (Automation not granted).
    /// Recoverable — see `open`, which falls back rather than giving up.
    var isPermissionDenied = false
}

enum BardolierTerminal {
    /// Used when the CLI config names no terminal. Matches the CLI's own
    /// default (`DEFAULT_TERMINAL` in cli/src/config.ts) — both read §8.
    static let fallbackName = "Terminal"

    /// The terminals offered in Preferences (§12). The list is a convenience,
    /// not a restriction: the config holds a free-form app name and anything
    /// installed can be typed in.
    static let suggested = ["Terminal", "iTerm", "Ghostty", "WezTerm", "Alacritty", "kitty"]

    /// Bundle identifiers for the names above, so Launch Services can be asked
    /// where an app IS rather than guessed at.
    ///
    /// Guessing was a bug: Terminal.app lives in `/System/Applications/
    /// Utilities`, not in any folder a reasonable list of "where apps live"
    /// starts with, so the built-in default was the one terminal the app could
    /// not find. Launch Services has no lookup by display name, hence a table —
    /// but it is only a fast path; an unknown name still falls through to the
    /// directory search below.
    nonisolated static let bundleIdentifiers = [
        "terminal": "com.apple.Terminal",
        "terminal.app": "com.apple.Terminal",
        "apple terminal": "com.apple.Terminal",
        "iterm": "com.googlecode.iterm2",
        "iterm2": "com.googlecode.iterm2",
        "iterm.app": "com.googlecode.iterm2",
        "ghostty": "com.mitchellh.ghostty",
        "wezterm": "com.github.wez.wezterm",
        "alacritty": "org.alacritty",
        "kitty": "net.kovidgoyal.kitty",
        "warp": "dev.warp.Warp-Stable",
    ]

    /// Where an app might be, when Launch Services can't say. Both Utilities
    /// folders included, which is the whole point.
    nonisolated static let applicationDirectories = [
        "/Applications",
        "/Applications/Utilities",
        "\(NSHomeDirectory())/Applications",
        "/System/Applications",
        "/System/Applications/Utilities",
    ]

    /// Terminals this app drives with AppleScript rather than a `.command`.
    nonisolated static func isScriptable(_ terminal: String) -> Bool {
        script(for: "", terminal: terminal) != nil
    }

    /// Run `invocation.exec` in `terminal`. Returns a note worth showing the
    /// user, or nil when it just worked.
    ///
    /// AppleScript is the preferred route for the terminals that support it,
    /// but the Automation permission it needs is the user's to grant and can be
    /// refused — and a refused permission is a bad reason to leave someone
    /// without the shell they asked for. The `.command` fallback needs no
    /// permission at all (it is a file handed to an app, not one app driving
    /// another), so a denial DEGRADES rather than fails: the shell opens, and
    /// the returned note says how to get the better route back.
    @MainActor
    static func open(_ invocation: ShellInvocation, in terminal: String) throws -> String? {
        let command = shellCommand(for: invocation.exec)

        if let source = script(for: command, terminal: terminal) {
            do {
                try runAppleScript(source, terminal: terminal)
                return nil
            } catch let failure as TerminalFailure where failure.isPermissionDenied {
                let fallback = try openViaCommandFile(command, project: invocation.project, terminal: terminal)
                let extra = fallback.map { " \($0)" } ?? ""
                return "Opened your shell through a .command file — \(failure.message)\(extra) "
                    + "That route is typed at a fresh login shell, so a prompt in your shell startup "
                    + "(oh-my-zsh\u{2019}s update check is the usual one) can swallow it: a window saying "
                    + "\u{201C}no such file or directory\u{201D} is that, not a missing project."
            }
        }
        return try openViaCommandFile(command, project: invocation.project, terminal: terminal)
    }

    // MARK: - Turning argv into something a terminal can run
    //
    // These four are `nonisolated` because they are pure string work — no
    // AppKit, no state. The target defaults to MainActor isolation, which would
    // otherwise make `argv.map(quoted)` an isolated function value used from a
    // synchronous nonisolated context, and that is an error. Marking the pure
    // half of this file explicitly is the honest fix; only the launching half
    // below actually needs the main actor.

    /// argv → a single command line, each argument quoted so that a container
    /// name or path with a space cannot become two arguments. The CLI returns
    /// argv precisely so this is the only place quoting happens (cli-spec.md §6).
    nonisolated static func shellCommand(for argv: [String]) -> String {
        argv.map(quoted).joined(separator: " ")
    }

    /// POSIX single-quoting: everything inside is literal, and the only thing
    /// that needs care is a quote itself.
    nonisolated private static func quoted(_ argument: String) -> String {
        "'" + argument.replacingOccurrences(of: "'", with: "'\\''") + "'"
    }

    /// AppleScript string literal escaping — backslash first, or it would
    /// escape the escapes it just added. A newline becomes the `\n` escape
    /// rather than a raw line break, because `guarded` sends two lines and an
    /// AppleScript literal is happier with the escape.
    nonisolated private static func literal(_ value: String) -> String {
        let escaped = value
            .replacingOccurrences(of: "\\", with: "\\\\")
            .replacingOccurrences(of: "\"", with: "\\\"")
            .replacingOccurrences(of: "\n", with: "\\n")
        return "\"\(escaped)\""
    }

    /// Terminal.app runs a command by TYPING it into a new login shell, and it
    /// types it before the shell's rc files have finished. An rc that reads a
    /// keystroke — oh-my-zsh's "Would you like to update? [Y/n]" is the common
    /// one — swallows the first character of what we typed, so `'docker' …`
    /// arrives as an unterminated quote and the shell hangs on `dquote>`.
    ///
    /// So type a sacrificial line first: `:` is the shell's silent no-op if it
    /// survives, and a "not Y" answer if a prompt eats it instead. Either way
    /// the command line behind it arrives whole. (The `.command` fallback below
    /// has the same exposure and no cure — Terminal types the file's path there,
    /// and that path is not ours to prefix.)
    nonisolated static func guarded(_ command: String) -> String {
        ":\n" + command
    }

    /// The script for a terminal we know how to drive, or nil for one we don't.
    nonisolated private static func script(for command: String, terminal: String) -> String? {
        switch terminal.lowercased() {
        case "terminal", "terminal.app", "apple terminal":
            return """
            tell application "Terminal"
                activate
                do script \(literal(guarded(command)))
            end tell
            """
        case "iterm", "iterm2", "iterm.app":
            // `create window with default profile command` runs it in a new
            // window with the user's profile, which is the closest analogue to
            // Terminal's `do script`.
            return """
            tell application "iTerm"
                activate
                create window with default profile command \(literal(command))
            end tell
            """
        default:
            return nil
        }
    }

    // MARK: - Launching

    @MainActor
    private static func runAppleScript(_ source: String, terminal: String) throws {
        var errorInfo: NSDictionary?
        guard let script = NSAppleScript(source: source) else {
            throw TerminalFailure(message: "Couldn’t build the AppleScript to drive \(terminal).")
        }
        script.executeAndReturnError(&errorInfo)
        guard let errorInfo else { return }

        let message = errorInfo[NSAppleScript.errorMessage] as? String ?? "AppleScript refused."
        let number = errorInfo[NSAppleScript.errorNumber] as? Int
        // -1743 is "not authorised to send Apple events", i.e. the Automation
        // permission was declined. Saying so is the difference between a fix
        // and a mystery.
        if number == -1743 {
            throw TerminalFailure(
                message: "macOS is blocking Bardolier from controlling \(terminal). "
                    + "Turn it on in System Settings → Privacy & Security → Automation → Bardolier. "
                    + "If Bardolier isn’t listed there, the permission was denied before it could be "
                    + "remembered: run `tccutil reset AppleEvents com.mw.bardolier`, then try again.",
                isPermissionDenied: true
            )
        }
        throw TerminalFailure(message: "\(terminal) couldn’t open a shell: \(message)")
    }

    /// The fallback for terminals we can't script: an executable `.command`
    /// that runs the invocation, handed to the chosen app. Returns a note when
    /// it had to use something other than the terminal that was asked for.
    @MainActor
    private static func openViaCommandFile(_ command: String, project: String, terminal: String) throws -> String? {
        let script = """
        #!/bin/sh
        # Written by Bardolier to open a shell in \(project) (app-spec.md §7).
        exec \(command)
        """
        let file = FileManager.default.temporaryDirectory.appendingPathComponent("bardolier-shell-\(project).command")
        do {
            try script.write(to: file, atomically: true, encoding: .utf8)
            try FileManager.default.setAttributes([.posixPermissions: 0o755], ofItemAtPath: file.path)
        } catch {
            throw TerminalFailure(message: "Couldn’t write the shell script: \(error.localizedDescription)")
        }

        guard let application = applicationURL(named: terminal) else {
            // Last resort: whatever this Mac opens a `.command` with — Terminal,
            // by default. A shell in the wrong terminal beats no shell, and the
            // note says which happened.
            if NSWorkspace.shared.open(file) {
                return "Couldn’t find \(terminal), so it opened in whichever app handles .command files."
            }
            throw TerminalFailure(
                message: "Couldn’t find \(terminal), and nothing on this Mac opened the shell script. "
                    + "Pick another terminal in Preferences, or give its full path."
            )
        }

        let configuration = NSWorkspace.OpenConfiguration()
        configuration.activates = true
        NSWorkspace.shared.open([file], withApplicationAt: application, configuration: configuration) { _, error in
            // Reported, not thrown: the open is asynchronous and the user has
            // already been given the file. A terminal that won't run a
            // `.command` is a Preferences problem, not a crash.
            if let error {
                NSLog("Bardolier: %@ could not open %@: %@", terminal, file.path, error.localizedDescription)
            }
        }
        return nil
    }

    /// Where an app called `<name>` lives: a full path if one was typed, then
    /// Launch Services by bundle id, then the conventional folders.
    @MainActor
    private static func applicationURL(named name: String) -> URL? {
        let trimmed = name.trimmingCharacters(in: .whitespaces)
        guard !trimmed.isEmpty else { return nil }

        // Preferences takes a free-form name; a full path is a name too.
        if trimmed.hasPrefix("/"), FileManager.default.fileExists(atPath: trimmed) {
            return URL(fileURLWithPath: trimmed)
        }

        if let identifier = bundleIdentifiers[trimmed.lowercased()],
           let url = NSWorkspace.shared.urlForApplication(withBundleIdentifier: identifier) {
            return url
        }

        let bundleName = trimmed.hasSuffix(".app") ? trimmed : "\(trimmed).app"
        for directory in applicationDirectories {
            let candidate = URL(fileURLWithPath: directory).appendingPathComponent(bundleName)
            if FileManager.default.fileExists(atPath: candidate.path) { return candidate }
        }
        return nil
    }
}
