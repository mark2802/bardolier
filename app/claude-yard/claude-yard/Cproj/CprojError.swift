//
//  CprojError.swift
//  claude-yard
//
//  The error contract: cli-spec.md §2 (stable codes) mapped to app-spec.md §13
//  (short human messages, never a raw stack trace).
//
//  Every failing `cproj … --json` prints `{"error":{"code","message"}}` on
//  stdout and exits non-zero. That envelope — not the exit status, not stderr —
//  is what the app reacts to. Anything that comes back malformed is a bug in
//  the pipe, not a business failure, and is reported as such so the two never
//  get confused.
//
//  Unknown codes are a designed-for case, not a defect: §2 calls the list "not
//  exhaustive", so an unrecognised code falls back to the CLI's own `message`
//  rather than to "something went wrong".
//

import Foundation

/// A stable `error.code` from cli-spec.md §2. Open, like the other tokens, so a
/// code added later still decodes and still renders (via `message`).
nonisolated struct CprojErrorCode: CprojToken {
    let rawValue: String

    // Codes named in cli-spec.md §2.
    static let ssdNotMounted = CprojErrorCode(rawValue: "SSD_NOT_MOUNTED")
    static let projectExists = CprojErrorCode(rawValue: "PROJECT_EXISTS")
    static let projectNotFound = CprojErrorCode(rawValue: "PROJECT_NOT_FOUND")
    static let projectRunning = CprojErrorCode(rawValue: "PROJECT_RUNNING")
    static let projectStopped = CprojErrorCode(rawValue: "PROJECT_STOPPED")
    static let serviceUnknown = CprojErrorCode(rawValue: "SERVICE_UNKNOWN")
    static let serviceAttached = CprojErrorCode(rawValue: "SERVICE_ATTACHED")
    static let serviceNotAttached = CprojErrorCode(rawValue: "SERVICE_NOT_ATTACHED")
    static let portUnavailable = CprojErrorCode(rawValue: "PORT_UNAVAILABLE")
    static let volumeInUse = CprojErrorCode(rawValue: "VOLUME_IN_USE")
    static let ejectBlocked = CprojErrorCode(rawValue: "EJECT_BLOCKED")
    static let dockerUnavailable = CprojErrorCode(rawValue: "DOCKER_UNAVAILABLE")

    // Codes the implementation adds under §2's "not exhaustive" allowance.
    static let invalidArgument = CprojErrorCode(rawValue: "INVALID_ARGUMENT")
    static let notImplemented = CprojErrorCode(rawValue: "NOT_IMPLEMENTED")
    static let configInvalid = CprojErrorCode(rawValue: "CONFIG_INVALID")
    static let volumeNotFound = CprojErrorCode(rawValue: "VOLUME_NOT_FOUND")
    static let internalError = CprojErrorCode(rawValue: "INTERNAL_ERROR")

    /// A short line for the UI, or nil when only the CLI's own message will do.
    /// app-spec.md §13: known codes get a human sentence, unknown ones fall
    /// back to `error.message`.
    var shortMessage: String? {
        switch self {
        case .ssdNotMounted: return "The SSD isn’t mounted."
        case .projectExists: return "A project with that name already exists."
        case .projectNotFound: return "No such project."
        case .projectRunning: return "Stop the project to change its services."
        case .projectStopped: return "The project isn’t running."
        case .serviceUnknown: return "That service isn’t in the catalogue."
        case .serviceAttached: return "That service is already attached."
        case .serviceNotAttached: return "That service isn’t attached."
        case .portUnavailable: return "The project’s host port is taken by something else."
        case .volumeInUse: return "That volume is still in use."
        case .ejectBlocked: return "Something is still holding the SSD."
        case .dockerUnavailable: return "Docker isn’t running."
        case .configInvalid: return "The cproj config or service catalogue is invalid."
        case .volumeNotFound: return "Docker doesn’t have a volume with that name."
        // INVALID_ARGUMENT, NOT_IMPLEMENTED and INTERNAL_ERROR are bugs in the
        // app's own invocation or in the CLI; the CLI's message is the useful
        // text, so don't paper over it.
        default: return nil
        }
    }
}

/// The wire shape of a failure under `--json`.
nonisolated struct CprojErrorEnvelope: Codable, Hashable, Sendable {
    let error: CprojErrorBody
}

nonisolated struct CprojErrorBody: Codable, Hashable, Sendable {
    let code: CprojErrorCode
    let message: String
    /// Code-specific detail; today only EJECT_BLOCKED carries any.
    let details: CprojErrorDetails?
}

/// Optional, additive detail. `details` is a free-form object in the schema, so
/// every field here is optional and unknown keys are ignored — a new detail on
/// an existing code can never break decoding, and a missing one is normal.
nonisolated struct CprojErrorDetails: Codable, Hashable, Sendable {
    /// EJECT_BLOCKED: who still holds the volume (app-spec.md §10).
    let holders: [SsdHolder]?
    /// EJECT_BLOCKED: why the check failed when `holders` is empty.
    let reason: String?
    /// PROJECT_*, SERVICE_*, VOLUME_IN_USE: the project concerned.
    let project: String?
    /// SERVICE_*: the catalogue key concerned.
    let service: String?
    /// PORT_UNAVAILABLE: the port that is taken — the one thing the user needs
    /// to know, since the CLI will not silently remap it (cli-spec.md §5).
    let port: Int?
    /// SERVICE_ATTACHED: the port the service already holds.
    let hostPort: Int?
    /// VOLUME_IN_USE: the volume concerned.
    let volume: String?
    /// PROJECT_STOPPED: the container that would have been used.
    let container: String?
    /// PROJECT_RUNNING: the state that blocked the change.
    let state: ProjectState?

    /// Every field defaults to absent, because every field IS usually absent:
    /// a code carries the one or two details it has and nothing else. Spelled
    /// out rather than left to the memberwise init so that adding a detail
    /// here does not break the call sites that don't set it.
    init(
        holders: [SsdHolder]? = nil,
        reason: String? = nil,
        project: String? = nil,
        service: String? = nil,
        port: Int? = nil,
        hostPort: Int? = nil,
        volume: String? = nil,
        container: String? = nil,
        state: ProjectState? = nil
    ) {
        self.holders = holders
        self.reason = reason
        self.project = project
        self.service = service
        self.port = port
        self.hostPort = hostPort
        self.volume = volume
        self.container = container
        self.state = state
    }
}

/// Everything that can go wrong between "the app wants to run a command" and
/// "the app has a decoded payload".
nonisolated enum CprojFailure: Error, Sendable {
    /// The CLI ran and reported a business failure in the documented envelope.
    case cli(CprojErrorBody)
    /// `cproj` could not be found. Carries the places that were searched
    /// (app-spec.md §13, the first-run message).
    case executableNotFound(searched: [String])
    /// The process could not be launched at all.
    case launchFailed(path: String, underlying: String)
    /// The CLI answered fine and the terminal is what wouldn't open (§7).
    /// Kept apart from `launchFailed` because the fix is different: nothing is
    /// wrong with `cproj`, and Preferences is where the terminal is chosen.
    case terminalFailed(terminal: String, underlying: String)
    /// Exit status said failure but stdout held no `{"error":…}` envelope —
    /// a crash, or something that wrote to stdout that shouldn't have.
    case unexpectedFailure(exitCode: Int32, stdout: String, stderr: String)
    /// Exit status said success but the payload didn't match the frozen schema.
    /// This is a contract violation, so it names the command and the reason.
    case decodingFailed(command: String, underlying: String, stdout: String)

    /// The error code, when this failure came from the CLI's own envelope.
    var code: CprojErrorCode? {
        if case .cli(let body) = self { return body.code }
        return nil
    }

    /// EJECT_BLOCKED's holder list, empty for anything else (app-spec.md §10).
    var holders: [SsdHolder] {
        if case .cli(let body) = self { return body.details?.holders ?? [] }
        return []
    }

    /// `details.reason`, when the CLI gave one. EJECT_BLOCKED uses it to say
    /// WHICH kind of refusal this is, which is the difference between an offer
    /// to stop the Docker engine and an instruction to quit an editor.
    var reason: String? {
        if case .cli(let body) = self { return body.details?.reason }
        return nil
    }

    /// EJECT_BLOCKED because Docker Desktop's VM holds the volume — the one
    /// refusal the app can clear itself, by asking the CLI to stop the engine.
    var isRuntimeHold: Bool { code == .ejectBlocked && reason == "runtime-holds-volume" }

    /// EJECT_BLOCKED with the engine ALREADY stopped and the volume still held.
    /// Kept apart from `isRuntimeHold` because the button that clears that one
    /// is the thing that has just been done: offering it again would be a loop.
    var isRuntimeHoldAfterStop: Bool { code == .ejectBlocked && reason == "runtime-holds-volume-after-stop" }
}

// Nonisolated for the same reason as CprojToken's extension: LocalizedError's
// requirements are nonisolated, and the target defaults to MainActor.
nonisolated extension CprojFailure: LocalizedError {
    /// The one place a failure becomes words on screen. Never a stack trace.
    var errorDescription: String? {
        switch self {
        case .cli(let body):
            return body.code.shortMessage ?? body.message
        case .executableNotFound(let searched):
            return "Can’t find the `cproj` command. Looked in: \(searched.joined(separator: ", "))."
        case .launchFailed(let path, let underlying):
            return "Couldn’t run \(path): \(underlying)"
        case .terminalFailed(let terminal, let underlying):
            return "Couldn’t open a shell in \(terminal). \(underlying)"
        case .unexpectedFailure(let exitCode, _, let stderr):
            let detail = stderr.trimmingCharacters(in: .whitespacesAndNewlines)
            return detail.isEmpty
                ? "cproj exited \(exitCode) without saying why."
                : "cproj exited \(exitCode): \(detail)"
        case .decodingFailed(let command, let underlying, _):
            return "Couldn’t read the output of `cproj \(command)`: \(underlying)"
        }
    }

    /// The CLI's own sentence, kept alongside the short message so a detail
    /// view can show both (§13: short message for the code, message for depth).
    var failureReason: String? {
        if case .cli(let body) = self { return body.message }
        return nil
    }

    var recoverySuggestion: String? {
        switch self {
        case .cli(let body) where body.code == .dockerUnavailable:
            return "Start Docker Desktop and try again."
        case .cli(let body) where body.code == .ssdNotMounted:
            return "Plug the SSD in, or set its path in Preferences."
        case .executableNotFound:
            return "Install it with `npm link` in the repo’s cli/ directory, or set its path with:\n"
                + "defaults write \(CprojExecutable.defaultsSuite) \(CprojExecutable.pathDefaultsKey) /path/to/cproj"
        case .terminalFailed:
            return "Pick a different terminal in Preferences. Terminal and iTerm are driven directly; "
                + "anything else opens through a .command file."
        default:
            return nil
        }
    }
}
