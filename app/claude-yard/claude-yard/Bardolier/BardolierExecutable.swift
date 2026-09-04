//
//  BardolierExecutable.swift
//  Bardolier
//
//  Finding `bardolier`, and giving it an environment it can work in.
//
//  A GUI app launched from Finder inherits almost nothing: no shell profile, a
//  PATH of roughly `/usr/bin:/bin:/usr/sbin:/sbin`. That breaks this app twice
//  over. First, `bardolier` itself lives wherever npm put it. Second — and less
//  obviously — `bardolier` is a `#!/usr/bin/env node` script that shells out to
//  `docker`, `lsof` and `diskutil`, so the CHILD's PATH has to be good enough
//  to find those or the CLI reports DOCKER_UNAVAILABLE on a perfectly healthy
//  machine. Both problems are solved here, once, rather than in the client.
//
//  Nothing here guesses at behaviour: it only locates a binary and hands it a
//  PATH. All orchestration stays in the CLI (CLAUDE.md).
//

import Foundation

nonisolated enum BardolierExecutable {
    /// Preference key holding an explicit path to `bardolier`, for installs the
    /// search below can't guess. Written by Preferences (app-spec.md §12) and
    /// settable by hand:
    ///   defaults write com.mw.bardolier BardolierPath /path/to/bardolier
    static let pathDefaultsKey = "BardolierPath"

    /// Named in the first-run message so the instruction can be copy-pasted.
    static let defaultsSuite = "com.mw.bardolier"

    /// Overrides the search entirely — how the app is run from Xcode against a
    /// working copy of the CLI.
    static let environmentOverride = "BARDOLIER_BIN"

    /// Where a Mac keeps user-installed CLIs, in the order a shell would.
    /// Homebrew (Apple silicon, then Intel), npm's global prefix, and the two
    /// conventional user bins.
    static let conventionalDirectories = [
        "/opt/homebrew/bin",
        "/usr/local/bin",
        "\(NSHomeDirectory())/.local/bin",
        "\(NSHomeDirectory())/.npm-global/bin",
        "\(NSHomeDirectory())/bin",
    ]

    /// PATH handed to the child, so `node`, `docker`, `lsof` and `diskutil`
    /// all resolve regardless of how this app was launched.
    static var childSearchPath: String {
        let inherited = ProcessInfo.processInfo.environment["PATH"]?
            .split(separator: ":")
            .map(String.init) ?? []
        let system = ["/usr/bin", "/bin", "/usr/sbin", "/sbin"]

        var seen = Set<String>()
        return (conventionalDirectories + inherited + system)
            .filter { seen.insert($0).inserted }
            .joined(separator: ":")
    }

    /// Every location consulted, in order — also the list the first-run message
    /// shows, so what the user is told matches what was actually tried.
    static var searchedLocations: [String] {
        var locations: [String] = []
        if let override = ProcessInfo.processInfo.environment[environmentOverride] {
            locations.append("$\(environmentOverride) (\(override))")
        }
        if let configured = UserDefaults.standard.string(forKey: pathDefaultsKey) {
            locations.append("\(pathDefaultsKey) preference (\(configured))")
        }
        locations.append(contentsOf: candidateDirectories.map { "\($0)/bardolier" })
        return locations
    }

    private static var candidateDirectories: [String] {
        childSearchPath.split(separator: ":").map(String.init)
    }

    /// Resolve `bardolier`, or throw the failure that carries the first-run message.
    static func resolve() throws -> URL {
        if let explicit = ProcessInfo.processInfo.environment[environmentOverride],
           let url = executable(at: explicit) {
            return url
        }
        if let configured = UserDefaults.standard.string(forKey: pathDefaultsKey),
           let url = executable(at: configured) {
            return url
        }
        for directory in candidateDirectories {
            if let url = executable(at: "\(directory)/bardolier") {
                return url
            }
        }
        throw BardolierFailure.executableNotFound(searched: searchedLocations)
    }

    /// A path is usable only if it exists AND is executable — a dangling npm
    /// symlink is a miss, not a launch failure later.
    private static func executable(at path: String) -> URL? {
        let expanded = (path as NSString).expandingTildeInPath
        guard FileManager.default.isExecutableFile(atPath: expanded) else { return nil }
        return URL(fileURLWithPath: expanded).resolvingSymlinksInPath()
    }
}
