//
//  CprojModels.swift
//  claude-yard
//
//  Codable mirrors of the frozen `cproj --json` schemas (cli/schema/*.json).
//
//  These types are the app's whole knowledge of the CLI. They are a MIRROR, not
//  a second source of truth: every property here exists because a schema says
//  it does, and the schemas are additive-only from Phase 4's contract freeze
//  onward. When a schema grows a field, add an optional property here; never
//  invent one, and never derive a value the CLI could have reported.
//
//  Two decisions worth stating once:
//
//  * Snake case is converted by the decoder (`CprojClient.decoder`), not by
//    hand-written CodingKeys. Every key in every schema is plain snake_case
//    with no acronym oddities, so the mapping is mechanical and the models stay
//    readable next to the schema files.
//
//  * Closed string enums in the schemas (`state`, `archetype`, …) are modelled
//    as `CprojToken` structs rather than Swift enums. An enum would make an
//    additive schema change — a fifth archetype, say — a DECODING FAILURE in an
//    older build of the app, turning "additive only" into a breaking change.
//    A token decodes anything and compares equal to the known constants.
//

import Foundation

// MARK: - Open string tokens

/// A string the schema constrains to a known set, decoded openly so an
/// additively-added value cannot break an older build (see file comment).
nonisolated protocol CprojToken: RawRepresentable, Codable, Hashable, CustomStringConvertible, Sendable
where RawValue == String {
    init(rawValue: String)
}

// `nonisolated` on the extension as well as the protocol: these members are the
// witnesses for Decodable, Encodable and CustomStringConvertible, all of whose
// requirements are nonisolated. Left unmarked, the target's default MainActor
// isolation would put them on the main actor and the conformances would cross
// actors — a warning today, an error in Swift 6 mode.
nonisolated extension CprojToken {
    init(from decoder: any Decoder) throws {
        self.init(rawValue: try decoder.singleValueContainer().decode(String.self))
    }

    func encode(to encoder: any Encoder) throws {
        var container = encoder.singleValueContainer()
        try container.encode(rawValue)
    }

    var description: String { rawValue }
}

/// `web | ios | android | library` — cli-spec.md §4.3.
nonisolated struct Archetype: CprojToken {
    let rawValue: String
    static let web = Archetype(rawValue: "web")
    static let ios = Archetype(rawValue: "ios")
    static let android = Archetype(rawValue: "android")
    static let library = Archetype(rawValue: "library")

    var display: String {
        switch self {
        case .web: return "Web"
        case .ios: return "iOS"
        case .android: return "Android"
        case .library: return "Library"
        default: return rawValue
        }
    }
}

/// `running | stopped | partial` — partial means some but not all of the
/// project's containers are up.
nonisolated struct ProjectState: CprojToken {
    let rawValue: String
    static let running = ProjectState(rawValue: "running")
    static let stopped = ProjectState(rawValue: "stopped")
    static let partial = ProjectState(rawValue: "partial")

    /// The menu shows Stop + Open shell for anything not fully stopped
    /// (app-spec.md §5); a partial project has something to stop.
    var isUp: Bool { self != .stopped }
}

/// `running | stopped` for one service container.
nonisolated struct ServiceState: CprojToken {
    let rawValue: String
    static let running = ServiceState(rawValue: "running")
    static let stopped = ServiceState(rawValue: "stopped")
}

/// Stable `doctor` finding ids the app may key UI off.
nonisolated struct DoctorFindingID: CprojToken {
    let rawValue: String
    static let config = DoctorFindingID(rawValue: "config")
    static let ssd = DoctorFindingID(rawValue: "ssd")
    static let docker = DoctorFindingID(rawValue: "docker")
    static let baseImages = DoctorFindingID(rawValue: "base_images")
    static let catalogue = DoctorFindingID(rawValue: "catalogue")
    static let manifests = DoctorFindingID(rawValue: "manifests")
}

/// `built | unavailable` for a base image.
nonisolated struct BaseImageStatus: CprojToken {
    let rawValue: String
    static let built = BaseImageStatus(rawValue: "built")
    static let unavailable = BaseImageStatus(rawValue: "unavailable")
}

// MARK: - status (cli-spec.md §7 — the app's primary contract)

/// `status` with a project name narrows `projects` but returns the same
/// envelope, so there is one type here, not two.
nonisolated struct CprojStatus: Codable, Hashable, Sendable {
    let ssd: SsdStatus
    let docker: DockerStatus
    let projects: [CprojProject]
    let orphanedVolumes: [OrphanedVolume]
}

nonisolated struct SsdStatus: Codable, Hashable, Sendable {
    let mounted: Bool
    /// Configured `$SSD_ROOT` — reportable even when `mounted` is false.
    let root: String
}

nonisolated struct DockerStatus: Codable, Hashable, Sendable {
    let available: Bool
}

nonisolated struct CprojProject: Codable, Hashable, Identifiable, Sendable {
    let name: String
    let archetype: Archetype
    let state: ProjectState
    let services: [ProjectService]
    /// Container name, or nil when the project is stopped.
    let devContainer: String?

    var id: String { name }
}

nonisolated struct ProjectService: Codable, Hashable, Identifiable, Sendable {
    let key: String
    let display: String
    let state: ServiceState
    /// The debugging tap on the Mac (§5). NOT what the dev app connects to —
    /// that is `containerPort` over the internal Docker network.
    let hostPort: Int
    let containerPort: Int
    let connectionHint: String

    var id: String { key }
}

nonisolated struct OrphanedVolume: Codable, Hashable, Identifiable, Sendable {
    let name: String
    let sizeBytes: Int
    let sizeHuman: String
    /// From the volume's `cproj.project` label, or nil when unattributable.
    let lastProject: String?

    var id: String { name }
}

// MARK: - list

nonisolated struct ProjectListOutput: Codable, Hashable, Sendable {
    let projects: [ProjectSummary]
}

nonisolated struct ProjectSummary: Codable, Hashable, Identifiable, Sendable {
    let name: String
    let archetype: Archetype
    let state: ProjectState

    var id: String { name }
}

// MARK: - doctor

nonisolated struct DoctorOutput: Codable, Hashable, Sendable {
    /// True when every finding is ok. `doctor` exits 0 even when findings fail.
    let ok: Bool
    let findings: [DoctorFinding]
}

nonisolated struct DoctorFinding: Codable, Hashable, Identifiable, Sendable {
    let id: DoctorFindingID
    let title: String
    let ok: Bool
    let detail: String
    /// Present only when the finding is actionable.
    let remedy: String?
}

// MARK: - shell (cli-spec.md §6 — the CLI names the command, the app spawns it)

nonisolated struct ShellInvocation: Codable, Hashable, Sendable {
    let project: String
    let container: String
    /// Argv to run verbatim — an array, so the app needs no quoting and no shell.
    let exec: [String]
    /// Where the shell lands inside the container.
    let workdir: String
}

// MARK: - new / up / down / delete

nonisolated struct NewOutput: Codable, Hashable, Sendable {
    let project: CreatedProject
    let manifestPath: String
    let composePath: String
    /// Seeded file names in write order (§10).
    let seeded: [String]
    let services: [AttachedService]
}

nonisolated struct CreatedProject: Codable, Hashable, Sendable {
    let name: String
    let archetype: Archetype
    let baseImage: String
    let dir: String
    /// RFC 3339 timestamp, kept as the string the CLI emitted.
    let created: String
}

/// The manifest's host port joined with the catalogue's identity — the shape
/// `new`, `service add`, `service remove` and `service list` all report.
nonisolated struct AttachedService: Codable, Hashable, Identifiable, Sendable {
    let key: String
    let display: String
    let hostPort: Int
    let containerPort: Int
    let connectionHint: String
    let volume: String

    var id: String { key }
}

nonisolated struct UpOutput: Codable, Hashable, Sendable {
    let project: String
    let state: ProjectState
    let devContainer: String
    let services: [UpService]
    /// True when `up` was an idempotent no-op (§2).
    let alreadyRunning: Bool
    let composeRegenerated: Bool
    /// The app's cue to open a shell; false under `--no-shell` (app-spec.md §7).
    let openShell: Bool
}

nonisolated struct UpService: Codable, Hashable, Identifiable, Sendable {
    let key: String
    let hostPort: Int
    let containerPort: Int

    var id: String { key }
}

nonisolated struct DownOutput: Codable, Hashable, Sendable {
    let project: String
    let state: ProjectState
    /// False when `down` was an idempotent no-op (§2).
    let wasRunning: Bool
    /// Always true: `down` never removes volumes.
    let dataKept: Bool
}

nonisolated struct DeleteOutput: Codable, Hashable, Sendable {
    let project: String
    /// False when the confirmation was declined; nothing was touched.
    let deleted: Bool
    let dir: String
    /// Host ports the project no longer holds, free for the next allocation (§5).
    let releasedPorts: [Int]
    /// Removed under `--purge`.
    let removedVolumes: [String]
    /// Left behind under `--keep-data`; they become listed orphans.
    let keptVolumes: [String]
}

// MARK: - service add / remove / list

nonisolated struct ServiceAddOutput: Codable, Hashable, Sendable {
    let project: String
    let added: AttachedService
    /// Every service attached afterwards, sorted by key.
    let services: [AttachedService]
    let composePath: String
    let composeRegenerated: Bool
}

nonisolated struct ServiceRemoveOutput: Codable, Hashable, Sendable {
    let project: String
    let removed: RemovedService
    /// Every service still attached, sorted by key.
    let services: [AttachedService]
    let composePath: String
    let composeRegenerated: Bool
}

nonisolated struct RemovedService: Codable, Hashable, Sendable {
    let key: String
    /// Released — free for the next allocation (§5).
    let hostPort: Int
    /// The KEPT volume (it becomes a listed orphan), or nil when the catalogue
    /// no longer defines the service.
    let volume: String?
}

nonisolated struct ServiceListOutput: Codable, Hashable, Sendable {
    let project: String
    let services: [AttachedService]
}

// MARK: - volumes

nonisolated struct OrphanedVolumesOutput: Codable, Hashable, Sendable {
    let orphaned: [OrphanedVolume]
    /// What reclaiming all of them would free.
    let totalBytes: Int
    let totalHuman: String
}

nonisolated struct VolumeRemoveOutput: Codable, Hashable, Sendable {
    let volume: String
    /// False when the confirmation was declined; nothing was touched.
    let removed: Bool
    let sizeBytes: Int
    let sizeHuman: String
    let lastProject: String?
}

// MARK: - down-all / eject

nonisolated struct DownAllOutput: Codable, Hashable, Sendable {
    let projects: [DownAllProject]
    /// Names of the projects actually stopped by this call.
    let stopped: [String]
    /// `cproj-*` containers removed that no manifest claims.
    let strayContainers: [String]
    /// False when the daemon was unreachable — a no-op success.
    let dockerAvailable: Bool
}

nonisolated struct DownAllProject: Codable, Hashable, Identifiable, Sendable {
    let name: String
    let wasRunning: Bool

    var id: String { name }
}

nonisolated struct EjectOutput: Codable, Hashable, Sendable {
    /// The mount point that was ejected, e.g. /Volumes/ssd.
    let volume: String
    let ejected: Bool
    let stopped: [String]
    /// Always empty on success; populated in `error.details.holders` on
    /// EJECT_BLOCKED (app-spec.md §10).
    let holders: [SsdHolder]
}

/// A process holding files open on the SSD, as `lsof` reports it.
nonisolated struct SsdHolder: Codable, Hashable, Identifiable, Sendable {
    let pid: Int
    let command: String
    let user: String?
    /// Enough paths to recognise it, not a file listing.
    let paths: [String]

    var id: Int { pid }
}

// MARK: - build / version

nonisolated struct BuildOutput: Codable, Hashable, Sendable {
    let uid: Int
    let gid: Int
    let images: [BaseImage]
}

nonisolated struct BaseImage: Codable, Hashable, Identifiable, Sendable {
    let image: String
    let archetypes: [Archetype]
    let status: BaseImageStatus
    let dockerfile: String?
    /// Why the image is unavailable; absent on success.
    let reason: String?

    var id: String { image }
}

nonisolated struct VersionOutput: Codable, Hashable, Sendable {
    let version: String
}
