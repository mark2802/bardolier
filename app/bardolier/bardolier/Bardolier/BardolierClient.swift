//
//  BardolierClient.swift
//  Bardolier
//
//  The single seam between the app and the engine (app-spec.md §4).
//
//  Everything the app knows about containers, ports, volumes and the SSD it
//  learns by running `bardolier … --json` through here and decoding the result.
//  There is no second path: no `docker` invocation, no reading of manifests, no
//  reimplementation of anything the CLI already decides. If a view seems to
//  need something this file can't ask for, the answer is a new CLI command, not
//  logic in Swift (CLAUDE.md).
//
//  Three rules this file exists to keep:
//
//  1. `--json` is appended by the client, never by a caller. Human output must
//     never reach a parser (cli-spec.md §2).
//  2. Exit status is not the contract — the `{"error":{"code"}}` envelope is.
//     A non-zero exit is decoded into `BardolierFailure.cli` so callers switch on a
//     stable code, and only a MALFORMED failure becomes `.unexpectedFailure`.
//  3. Destructive commands are always given `--force`. The CLI refuses to
//     prompt with no terminal, and under `--json` it refuses outright; the
//     confirmation is the app's job (app-spec.md §6, §9) and must happen
//     BEFORE the call.
//

import Foundation

nonisolated struct BardolierClient: Sendable {
    /// Resolved lazily per call so that installing `bardolier`, or pointing the
    /// preference at it, fixes a first-run failure without relaunching.
    private let locate: @Sendable () throws -> URL

    init(locate: @escaping @Sendable () throws -> URL = BardolierExecutable.resolve) {
        self.locate = locate
    }

    // MARK: - Commands (cli-spec.md §6)

    /// Full status object(s) — §7, the app's primary contract. `project: nil`
    /// means every project. Never fails except PROJECT_NOT_FOUND.
    func status(project: String? = nil) async throws -> BardolierStatus {
        try await run(["status"] + (project.map { [$0] } ?? []))
    }

    /// Projects with archetype and running state. Cheaper than `status`; used
    /// by the New-project window to check for a name collision (§8).
    func list() async throws -> ProjectListOutput {
        try await run(["list"])
    }

    /// Environment check. Called on launch (§4); exits 0 even when findings fail.
    func doctor() async throws -> DoctorOutput {
        try await run(["doctor"])
    }

    /// Every service type the catalogue defines — the list the Services submenu
    /// ticks against (§6) and the New-project window offers (§8). Asking the
    /// CLI is the point: a copy of `services.yml` in Swift is the desync a
    /// single editable catalogue exists to prevent.
    func catalogue() async throws -> CatalogueOutput {
        try await run(["catalogue"])
    }

    /// The effective CLI config — what Preferences shows before it writes (§12).
    func configGet() async throws -> ConfigGetOutput {
        try await run(["config", "get"])
    }

    /// Write one config key. An empty value clears it. Preferences goes through
    /// here rather than editing `config.yml`, so precedence and path expansion
    /// stay the CLI's (cli-spec.md §8).
    func configSet(_ key: ConfigKey, to value: String) async throws -> ConfigSetOutput {
        try await run(["config", "set", key.rawValue, value])
    }

    func new(name: String, archetype: Archetype, services: [String] = []) async throws -> NewOutput {
        var argv = ["new", name, "--archetype", archetype.rawValue]
        if !services.isEmpty {
            argv += ["--services", services.joined(separator: ",")]
        }
        return try await run(argv)
    }

    /// Start a project. `openShell` only sets the CUE in the response — the CLI
    /// spawns no terminal; the app does (app-spec.md §7).
    func up(project: String, openShell: Bool) async throws -> UpOutput {
        try await run(["up", project] + (openShell ? [] : ["--no-shell"]))
    }

    func down(project: String) async throws -> DownOutput {
        try await run(["down", project])
    }

    /// Delete a project. `purge` also destroys its named volumes; the default
    /// keeps them as reclaimable orphans. CONFIRM WITH THE USER FIRST — this
    /// always passes `--force`.
    func delete(project: String, purge: Bool = false) async throws -> DeleteOutput {
        try await run(["delete", project, "--force"] + (purge ? ["--purge"] : ["--keep-data"]))
    }

    /// Attach a service. Fails PROJECT_RUNNING unless the project is stopped —
    /// the app relays that refusal, it does not work around it (§6).
    func serviceAdd(project: String, service: String) async throws -> ServiceAddOutput {
        try await run(["service", "add", project, service])
    }

    /// Detach a service. The data volume is KEPT and becomes a listed orphan.
    func serviceRemove(project: String, service: String) async throws -> ServiceRemoveOutput {
        try await run(["service", "remove", project, service])
    }

    func serviceList(project: String) async throws -> ServiceListOutput {
        try await run(["service", "list", project])
    }

    /// The exec invocation for a running project's dev container. The app
    /// launches the user's terminal with `exec` verbatim.
    ///
    /// `root: true` appends `--root` (Option-held "Open root shell" in the
    /// menu, phase 14) — same seam as every other flag this client appends
    /// itself; no caller may append `--root` any more than `--json`.
    func shell(project: String, root: Bool = false) async throws -> ShellInvocation {
        try await run(["shell", project] + (root ? ["--root"] : []))
    }

    func orphanedVolumes() async throws -> OrphanedVolumesOutput {
        try await run(["volumes", "orphaned"])
    }

    /// Destroys data. CONFIRM WITH THE USER FIRST — this passes `--force`.
    func removeVolume(name: String) async throws -> VolumeRemoveOutput {
        try await run(["volumes", "rm", name, "--force"])
    }

    func downAll() async throws -> DownAllOutput {
        try await run(["down-all"])
    }

    /// down-all, holder check, eject. On EJECT_BLOCKED the thrown failure
    /// carries `holders` for the app to render (app-spec.md §10). Never forces.
    ///
    /// `stopDocker` is not a force and is not a default: it answers, up front,
    /// the one question `bardolier eject` would otherwise ask at a terminal the app
    /// does not have — whether it may stop the Docker ENGINE when that VM's
    /// file share is what holds the disk. The user answers it by pressing the
    /// button the blocked panel offers, never by the app deciding.
    func eject(stopDocker: Bool = false) async throws -> EjectOutput {
        try await run(["eject"] + (stopDocker ? ["--stop-docker"] : []))
    }

    func build(archetype: Archetype? = nil) async throws -> BuildOutput {
        try await run(["build"] + (archetype.map { ["--archetype", $0.rawValue] } ?? []))
    }

    /// Cheapest possible round trip — used to prove the resolved binary works.
    func version() async throws -> VersionOutput {
        try await run(["--version"])
    }

    // MARK: - Invocation

    /// Decoder for every payload. Snake case is converted here, in one place,
    /// so the models can read like the schema files (see BardolierModels.swift).
    /// Built per call rather than shared: a JSONDecoder is not Sendable, and
    /// commands run concurrently.
    static var decoder: JSONDecoder {
        let decoder = JSONDecoder()
        decoder.keyDecodingStrategy = .convertFromSnakeCase
        return decoder
    }

    /// Run one command and decode its payload. `--json` is appended here so no
    /// caller can forget it.
    func run<Payload: Decodable>(_ argv: [String]) async throws -> Payload {
        let executable = try locate()
        let arguments = argv + ["--json"]
        let result = try await Self.execute(executable: executable, arguments: arguments)

        // The envelope, not the exit status, is the contract (§2). Decode a
        // failure first so a command that fails informatively stays informative.
        if result.exitCode != 0 {
            if let envelope = try? Self.decoder.decode(BardolierErrorEnvelope.self, from: result.stdout) {
                throw BardolierFailure.cli(envelope.error)
            }
            throw BardolierFailure.unexpectedFailure(
                exitCode: result.exitCode,
                stdout: result.stdoutText,
                stderr: result.stderrText
            )
        }

        do {
            return try Self.decoder.decode(Payload.self, from: result.stdout)
        } catch {
            // Exit 0 with an unreadable payload means the frozen schema and
            // these models have diverged. Say so plainly rather than showing
            // the user a Swift decoding error.
            throw BardolierFailure.decodingFailed(
                command: argv.joined(separator: " "),
                underlying: String(describing: error),
                stdout: result.stdoutText
            )
        }
    }

    private struct ExecutionResult {
        let exitCode: Int32
        let stdout: Data
        let stderr: Data

        var stdoutText: String { String(decoding: stdout, as: UTF8.self) }
        var stderrText: String { String(decoding: stderr, as: UTF8.self) }
    }

    /// Launch, drain both pipes concurrently, wait for exit.
    ///
    /// The pipes are drained on their own threads rather than after exit: a
    /// child that outruns the 64 KB pipe buffer would block forever writing
    /// while we waited for it to finish. A DispatchGroup joins the two reads
    /// and the termination callback into the single `await` below.
    private static func execute(executable: URL, arguments: [String]) async throws -> ExecutionResult {
        let process = Process()
        process.executableURL = executable
        process.arguments = arguments

        // A GUI app's PATH can't find node, docker or diskutil — see
        // BardolierExecutable. Everything else is inherited unchanged, so
        // BDLR_SSD_ROOT and friends still work when launched from a shell.
        var environment = ProcessInfo.processInfo.environment
        environment["PATH"] = BardolierExecutable.childSearchPath
        process.environment = environment

        let stdoutPipe = Pipe()
        let stderrPipe = Pipe()
        process.standardOutput = stdoutPipe
        process.standardError = stderrPipe
        // No terminal, and nothing to answer: a destructive command without
        // --force must fail rather than sit on a prompt (cli/src/confirm.ts).
        process.standardInput = FileHandle.nullDevice

        let collected = OutputBox()
        let group = DispatchGroup()

        group.enter()
        process.terminationHandler = { _ in group.leave() }

        do {
            try process.run()
        } catch {
            process.terminationHandler = nil
            group.leave()
            throw BardolierFailure.launchFailed(path: executable.path, underlying: error.localizedDescription)
        }

        group.enter()
        DispatchQueue.global(qos: .userInitiated).async {
            collected.setStandardOutput(stdoutPipe.fileHandleForReading.readDataToEndOfFile())
            group.leave()
        }
        group.enter()
        DispatchQueue.global(qos: .userInitiated).async {
            collected.setStandardError(stderrPipe.fileHandleForReading.readDataToEndOfFile())
            group.leave()
        }

        await withCheckedContinuation { (continuation: CheckedContinuation<Void, Never>) in
            group.notify(queue: .global(qos: .userInitiated)) {
                continuation.resume()
            }
        }

        return ExecutionResult(
            exitCode: process.terminationStatus,
            stdout: collected.standardOutput,
            stderr: collected.standardError
        )
    }
}

/// Somewhere for two reader threads to put their bytes. Small enough to keep
/// here; a lock is the whole of it.
private nonisolated final class OutputBox: @unchecked Sendable {
    private let lock = NSLock()
    private var out = Data()
    private var err = Data()

    func setStandardOutput(_ data: Data) {
        lock.withLock { out = data }
    }

    func setStandardError(_ data: Data) {
        lock.withLock { err = data }
    }

    var standardOutput: Data { lock.withLock { out } }
    var standardError: Data { lock.withLock { err } }
}
