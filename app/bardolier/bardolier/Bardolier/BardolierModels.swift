//
//  BardolierModels.swift
//  Bardolier
//
//  Codable mirrors of the frozen `bardolier --json` schemas (cli/schema/*.json).
//
//  These types are the app's whole knowledge of the CLI. They are a MIRROR, not
//  a second source of truth: every property here exists because a schema says
//  it does, and the schemas are additive-only from Phase 4's contract freeze
//  onward. When a schema grows a field, add an optional property here; never
//  invent one, and never derive a value the CLI could have reported.
//
//  Two decisions worth stating once:
//
//  * Snake case is converted by the decoder (`BardolierClient.decoder`), not by
//    hand-written CodingKeys. Every key in every schema is plain snake_case
//    with no acronym oddities, so the mapping is mechanical and the models stay
//    readable next to the schema files.
//
//  * Closed string enums in the schemas (`state`, `archetype`, …) are modelled
//    as `BardolierToken` structs rather than Swift enums. An enum would make an
//    additive schema change — a fifth archetype, say — a DECODING FAILURE in an
//    older build of the app, turning "additive only" into a breaking change.
//    A token decodes anything and compares equal to the known constants.
//

import Foundation

// MARK: - Open string tokens

/// A string the schema constrains to a known set, decoded openly so an
/// additively-added value cannot break an older build (see file comment).
nonisolated protocol BardolierToken: RawRepresentable, Codable, Hashable, CustomStringConvertible, Sendable
where RawValue == String {
    init(rawValue: String)
}

// `nonisolated` on the extension as well as the protocol: these members are the
// witnesses for Decodable, Encodable and CustomStringConvertible, all of whose
// requirements are nonisolated. Left unmarked, the target's default MainActor
// isolation would put them on the main actor and the conformances would cross
// actors — a warning today, an error in Swift 6 mode.
nonisolated extension BardolierToken {
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
nonisolated struct Archetype: BardolierToken {
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
nonisolated struct ProjectState: BardolierToken {
    let rawValue: String
    static let running = ProjectState(rawValue: "running")
    static let stopped = ProjectState(rawValue: "stopped")
    static let partial = ProjectState(rawValue: "partial")

    /// The menu shows Stop + Open shell for anything not fully stopped
    /// (app-spec.md §5); a partial project has something to stop.
    var isUp: Bool { self != .stopped }
}

/// `rename | copy` — cli-spec.md §6. `rename` on one filesystem (also reported
/// for the no-op); `copy` when EXDEV forced a staged copy.
nonisolated struct MoveMode: BardolierToken {
    let rawValue: String
    static let rename = MoveMode(rawValue: "rename")
    static let copy = MoveMode(rawValue: "copy")
}

/// `running | stopped` for one service container.
nonisolated struct ServiceState: BardolierToken {
    let rawValue: String
    static let running = ServiceState(rawValue: "running")
    static let stopped = ServiceState(rawValue: "stopped")
}

/// `config | ssd | bundled` — which step of the §4.1 chain answered.
nonisolated struct CatalogueOrigin: BardolierToken {
    let rawValue: String
    static let config = CatalogueOrigin(rawValue: "config")
    static let ssd = CatalogueOrigin(rawValue: "ssd")
    static let bundled = CatalogueOrigin(rawValue: "bundled")
}

/// A settable key of the CLI config file (cli-spec.md §8) — what Preferences
/// writes through `bardolier config set` (app-spec.md §12). `roots` is
/// list-valued and is not settable this way — see `ConfiguredRoot` and
/// `bardolier root add | remove | list` (phase 18).
nonisolated struct ConfigKey: BardolierToken {
    let rawValue: String
    static let cataloguePath = ConfigKey(rawValue: "catalogue_path")
    static let terminal = ConfigKey(rawValue: "terminal")
}

/// Stable `doctor` finding ids the app may key UI off.
nonisolated struct DoctorFindingID: BardolierToken {
    let rawValue: String
    static let config = DoctorFindingID(rawValue: "config")
    static let ssd = DoctorFindingID(rawValue: "ssd")
    static let docker = DoctorFindingID(rawValue: "docker")
    static let baseImages = DoctorFindingID(rawValue: "base_images")
    static let catalogue = DoctorFindingID(rawValue: "catalogue")
    static let manifests = DoctorFindingID(rawValue: "manifests")
    static let ports = DoctorFindingID(rawValue: "ports")
    static let cli = DoctorFindingID(rawValue: "cli")
}

/// `volume | directory` — what one row of `volumes orphaned` would reclaim
/// (phase 19). Open, like every token here, so a later kind cannot break this
/// build.
nonisolated struct OrphanKind: BardolierToken {
    let rawValue: String
    static let volume = OrphanKind(rawValue: "volume")
    static let directory = OrphanKind(rawValue: "directory")
}

/// `built | unavailable` for a base image.
nonisolated struct BaseImageStatus: BardolierToken {
    let rawValue: String
    static let built = BaseImageStatus(rawValue: "built")
    static let unavailable = BaseImageStatus(rawValue: "unavailable")
}

// MARK: - status (cli-spec.md §7 — the app's primary contract)

/// `status` with a project name narrows `projects` but returns the same
/// envelope, so there is one type here, not two.
nonisolated struct BardolierStatus: Codable, Hashable, Sendable {
    let ssd: SsdStatus
    let docker: DockerStatus
    let projects: [BardolierProject]
    let orphanedVolumes: [OrphanedVolume]
    /// Every configured root's readable state. Additive since phase 18.
    let roots: [ConfiguredRoot]?
}

nonisolated struct SsdStatus: Codable, Hashable, Sendable {
    let mounted: Bool
    /// The default root's path (`roots[0]`) — reportable even when `mounted`
    /// is false. See `roots` on `BardolierStatus` for every configured root.
    let root: String
}

/// One configured root (cli-spec.md §8, phase 18) — mirrors `status.roots`
/// and every `root add | remove | list` payload.
nonisolated struct ConfiguredRoot: Codable, Hashable, Identifiable, Sendable {
    let name: String
    let path: String
    let mounted: Bool
    /// When this root was last scanned (phase 27) — nil while mounted (its
    /// index is reconciled on every `status` call, so this stays
    /// uninteresting) or never indexed. `root add|remove|list` never set it.
    let lastIndexed: String?

    var id: String { name }
}

/// One root a command could not read while it ran (cli-spec.md §5, §8;
/// phase 27) — allocation used its last known state instead of refusing.
/// Mirrors `$defs/offline_root`, duplicated across new/clone/service-add/port-add.
nonisolated struct OfflineRoot: Codable, Hashable, Sendable {
    let root: String
    let path: String
    let lastIndexed: String?
}

nonisolated struct DockerStatus: Codable, Hashable, Sendable {
    let available: Bool
}

nonisolated struct BardolierProject: Codable, Hashable, Identifiable, Sendable {
    let name: String
    /// The project's directory (cli-spec.md §3), reported by the CLI rather
    /// than composed here — "Open folder in Finder" must not encode the layout.
    let dir: String
    let archetype: Archetype
    let state: ProjectState
    let services: [ProjectService]
    /// Container name, or nil when the project is stopped.
    let devContainer: String?
    /// Host port the archetype's dev server is published on (§9), or nil when
    /// this project publishes none — a non-web archetype, or one that predates
    /// the field and has not been restarted since.
    let appPort: Int?
    /// The URL that opens `appPort`. Taken from the CLI rather than built from
    /// the port here, for the same reason `connectionHint` is: the scheme is
    /// the contract's business, not the menu's.
    ///
    /// Spelled `appUrl`, not `appURL`, because `.convertFromSnakeCase` is what
    /// maps it — the decoder produces `appUrl` from `app_url`, and an API-style
    /// rename here would need a `CodingKeys` that says the same thing twice.
    let appUrl: String?
    /// Extra ports declared on this project (§5.1), sorted by name. Additive
    /// since Phase 12 — absent on an older CLI, decoded as nil either way.
    let extraPorts: [AttachedExtraPort]?
    /// The configured root's name this project lives under. Additive since phase 18.
    let root: String?
    /// `<dir>/work`, where repositories live and the dev container works
    /// (§4.2). Reported for the same reason `dir` is: no path is composed here.
    /// Additive since phase 19.
    let workDir: String?

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
    /// A Docker volume name, or `<project>/<key>` for a data directory.
    let name: String
    /// What reclaiming this destroys (phase 19). Nil on an older CLI, which
    /// only ever reported volumes.
    let kind: OrphanKind?
    /// Host path of a `directory` orphan; nil for a named volume.
    let path: String?
    let sizeBytes: Int
    let sizeHuman: String
    /// The volume's `bardolier.project` label, or the project whose `data/` holds
    /// the directory; nil when unattributable.
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
    /// The configured root's name this project lives under. Additive since phase 18.
    let root: String?

    var id: String { name }
}

// MARK: - doctor

nonisolated struct DoctorOutput: Codable, Hashable, Sendable {
    /// True when every finding is ok. `doctor` exits 0 even when findings fail.
    let ok: Bool
    let findings: [DoctorFinding]
}

/// One configured root's state, as reported on the `ssd` finding. Additive since phase 18.
nonisolated struct DoctorRootState: Codable, Hashable, Identifiable, Sendable {
    let name: String
    let path: String
    let mounted: Bool
    /// Whether `diskutil` reports this as a removable, non-internal volume —
    /// what tells "SSD" wording apart from "internal folder" wording. Nil
    /// when the root isn't currently mounted: there is nothing to ask, and
    /// the CLI never guesses.
    let removable: Bool?

    var id: String { name }
}

nonisolated struct DoctorFinding: Codable, Hashable, Identifiable, Sendable {
    let id: DoctorFindingID
    let title: String
    let ok: Bool
    let detail: String
    /// Present only when the finding is actionable.
    let remedy: String?
    /// Per-root state. Present only on the `ssd` finding. Additive since phase 18.
    let roots: [DoctorRootState]?
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

// MARK: - new / clone / up / down / delete

nonisolated struct NewOutput: Codable, Hashable, Sendable {
    let project: CreatedProject
    let manifestPath: String
    let composePath: String
    /// Seeded file names in write order (§10).
    let seeded: [String]
    let services: [AttachedService]
    /// Present only when a configured root could not be read while this ran
    /// (phase 27) — ports were allocated against its last known state.
    let degradedRoots: [OfflineRoot]?
}

nonisolated struct CreatedProject: Codable, Hashable, Sendable {
    let name: String
    let archetype: Archetype
    let baseImage: String
    let dir: String
    /// RFC 3339 timestamp, kept as the string the CLI emitted.
    let created: String
    /// The configured root's name this project was created under. Additive since phase 18.
    let root: String?
}

/// What `clone` created (phase 20) — `NewOutput`'s fields plus what makes it a
/// copy. The same `project` and `services` blocks, because a clone IS a new
/// project; only the three trailing fields are its own.
nonisolated struct CloneOutput: Codable, Hashable, Sendable {
    let project: CreatedProject
    let manifestPath: String
    let composePath: String
    /// Seeded file names in write order (§10). Empty when the copy brought them.
    let seeded: [String]
    /// Carried over from the source, each with a FRESHLY assigned host port —
    /// no host port is ever copied (cli-spec.md §5, §6).
    let services: [AttachedService]
    /// The project this one was shaped from. Never modified by the clone.
    let source: String
    /// Whether the project's four folders (§3) were copied byte-for-byte.
    let withContent: Bool
    /// Bytes copied; 0 for a shape-only clone.
    let bytesCopied: Int
    /// Present only when a configured root could not be read while this ran
    /// (phase 27) — ports were allocated against its last known state.
    let degradedRoots: [OfflineRoot]?
}

/// What `move` did (phase 21, §8.2) — a project's ports never change, so this
/// is reported by the manifest's new location, never by rewriting anything
/// inside the directory.
nonisolated struct MoveOutput: Codable, Hashable, Sendable {
    let project: String
    /// False when the project was already under the target root — `move` is
    /// idempotent (§2).
    let moved: Bool
    let from: MoveLocation
    let to: MoveLocation
    /// The project's size on disk, reported in both modes; 0 for a no-op.
    let bytes: Int
    let mode: MoveMode
}

nonisolated struct MoveLocation: Codable, Hashable, Sendable {
    let root: String
    let dir: String
}

/// The manifest's host port joined with the catalogue's identity — the shape
/// `new`, `service add`, `service remove` and `service list` all report.
nonisolated struct AttachedService: Codable, Hashable, Identifiable, Sendable {
    let key: String
    let display: String
    let hostPort: Int
    let containerPort: Int
    let connectionHint: String
    /// Absolute path of this service's data directory, `<project>/data/<key>`
    /// (phase 19). There is no named volume behind a service any more.
    let dataDir: String

    var id: String { key }
}

/// A declared extra port (cli-spec.md §5.1): no catalogue behind it, unlike
/// `AttachedService` — just the caller's own name and the two ports. `url`
/// stands in for `connectionHint`, for the same reason: the scheme is the
/// contract's business, not the menu's.
nonisolated struct AttachedExtraPort: Codable, Hashable, Identifiable, Sendable {
    let name: String
    let hostPort: Int
    let containerPort: Int
    let url: String

    var id: String { name }
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
    /// Both are empty since phase 19: a project's data lives inside its
    /// directory and goes with it.
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
    /// Present only when a configured root could not be read while this ran (phase 27).
    let degradedRoots: [OfflineRoot]?
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
    /// The KEPT data directory; it becomes a listed orphan of the project.
    /// Named by the catalogue key, so it is knowable even when the catalogue
    /// has forgotten the service.
    let dataDir: String
}

nonisolated struct ServiceListOutput: Codable, Hashable, Sendable {
    let project: String
    let services: [AttachedService]
}

// MARK: - port add / remove / list

nonisolated struct PortAddOutput: Codable, Hashable, Sendable {
    let project: String
    let added: AttachedExtraPort
    /// Every extra port declared afterwards, sorted by name.
    let extraPorts: [AttachedExtraPort]
    let composePath: String
    let composeRegenerated: Bool
    /// Present only when a configured root could not be read while this ran (phase 27).
    let degradedRoots: [OfflineRoot]?
}

nonisolated struct PortRemoveOutput: Codable, Hashable, Sendable {
    let project: String
    let removed: RemovedExtraPort
    /// Every extra port still declared, sorted by name.
    let extraPorts: [AttachedExtraPort]
    let composePath: String
    let composeRegenerated: Bool
}

nonisolated struct RemovedExtraPort: Codable, Hashable, Sendable {
    let name: String
    /// Released — free for the next allocation (§5.1).
    let hostPort: Int
}

nonisolated struct PortListOutput: Codable, Hashable, Sendable {
    let project: String
    let extraPorts: [AttachedExtraPort]
}

// MARK: - deps add / remove / list

nonisolated struct DepsAddOutput: Codable, Hashable, Sendable {
    let project: String
    /// The package(s) just declared.
    let added: [String]
    /// Every package declared afterwards, sorted.
    let extraPackages: [String]
    /// The image this project's dev container now builds/runs from.
    let image: String
}

nonisolated struct DepsRemoveOutput: Codable, Hashable, Sendable {
    let project: String
    let removed: [String]
    /// Every package still declared, sorted.
    let extraPackages: [String]
    let image: String
}

nonisolated struct DepsListOutput: Codable, Hashable, Sendable {
    let project: String
    let extraPackages: [String]
    let image: String
}

// MARK: - volumes

nonisolated struct OrphanedVolumesOutput: Codable, Hashable, Sendable {
    let orphaned: [OrphanedVolume]
    /// What reclaiming all of them would free.
    let totalBytes: Int
    let totalHuman: String
    /// Roots this scan skipped named-volume claims for — unreadable and never
    /// indexed (phase 27). Present only when non-empty; directory orphans
    /// above are unaffected.
    let unverifiedRoots: [String]?
}

nonisolated struct VolumeRemoveOutput: Codable, Hashable, Sendable {
    /// The orphan's name — a Docker volume, or `<project>/<key>`.
    let volume: String
    /// What was reclaimed (phase 19). Nil on an older CLI.
    let kind: OrphanKind?
    /// Host path of a `directory` orphan; nil for a named volume.
    let path: String?
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
    /// `bardolier-*` containers removed that no manifest claims.
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
    /// True when the Docker engine had to be stopped to release the volume.
    /// Optional because the field is additive: a CLI from before it says
    /// nothing, and nothing is the same as false here.
    let dockerStopped: Bool?
    /// The configured root's name that was ejected. Additive since phase 18.
    let root: String?
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

/// `bardolier eject --all` (phase 22): down-all once, then every mounted
/// removable root, best-effort — one blocked disk must not hide a clean one.
nonisolated struct EjectAllOutput: Codable, Hashable, Sendable {
    let stopped: [String]
    let results: [EjectAllResult]
}

/// One root's outcome within `EjectAllOutput`. Never a thrown failure — a
/// blocked disk is `ejected: false` naming why, alongside any that succeeded.
nonisolated struct EjectAllResult: Codable, Hashable, Identifiable, Sendable {
    let root: String
    let volume: String
    let ejected: Bool
    /// Who still held it, when `ejected` is false. Empty on success.
    let holders: [SsdHolder]
    let dockerStopped: Bool
    /// The refusal's own sentence, when `ejected` is false.
    let message: String?

    var id: String { root }
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
    /// Platform the image is pinned to; absent when it builds for this Mac's own.
    let platform: String?
    /// The Claude Code version passed to this build — `latest` by default, or the exact `X.Y.Z` `--claude-code-version` asked for. Present whenever `status` is `built`; absent for `unavailable`.
    let claudeCodeVersion: String?

    var id: String { image }
}

nonisolated struct VersionOutput: Codable, Hashable, Sendable {
    let version: String
}

// MARK: - catalogue (app-spec.md §6, §8 — what may be attached)

/// Every service type the catalogue defines. The Services submenu ticks the
/// attached rows of THIS list, and New-project offers it; the app keeps no
/// copy of `services.yml` of its own.
nonisolated struct CatalogueOutput: Codable, Hashable, Sendable {
    /// The `services.yml` that answered.
    let path: String
    let origin: CatalogueOrigin
    /// Every catalogue entry, sorted by key.
    let services: [CatalogueService]
}

nonisolated struct CatalogueService: Codable, Hashable, Identifiable, Sendable {
    let key: String
    let display: String
    let image: String
    let containerPort: Int
    /// Start of this service's host-port band (cli-spec.md §5). NOT a port any
    /// project holds — an assigned port only ever comes from a manifest, which
    /// means from `status` or a `service add` response.
    let hostPortBase: Int

    var id: String { key }
}

// MARK: - root add / remove / list (cli-spec.md §8, phase 18)

nonisolated struct RootAddOutput: Codable, Hashable, Sendable {
    let path: String
    let created: Bool
    let added: ConfiguredRoot
    /// Every configured root afterwards, in order.
    let roots: [ConfiguredRoot]
}

nonisolated struct RootRemoveOutput: Codable, Hashable, Sendable {
    let path: String
    let removed: ConfiguredRoot
    /// Every configured root afterwards, in order.
    let roots: [ConfiguredRoot]
}

nonisolated struct RootListOutput: Codable, Hashable, Sendable {
    /// Every configured root, in order; `roots[0]` is the default `new` targets.
    let roots: [ConfiguredRoot]
}

// MARK: - config get / set (app-spec.md §12)

/// Every settable §8 key, resolved: defaults, then the file, then the
/// environment. Roots are list-valued and reported by `bardolier root list`
/// instead (phase 18) — see `ConfiguredRoot`.
nonisolated struct EffectiveConfig: Codable, Hashable, Sendable {
    /// nil when unset — the §4.1 fallback chain applies.
    let cataloguePath: String?
    let terminal: String
}

nonisolated struct ConfigGetOutput: Codable, Hashable, Sendable {
    /// The config file consulted, whether or not it exists.
    let path: String
    let exists: Bool
    let config: EffectiveConfig
    /// Environment variables that overrode a value. A key named here cannot be
    /// changed by writing the file, so Preferences says so instead of
    /// appearing to succeed.
    let overrides: [String]
}

nonisolated struct ConfigSetOutput: Codable, Hashable, Sendable {
    let path: String
    let created: Bool
    /// Keys whose stored value actually changed; empty means a no-op write.
    let changed: [ConfigKey]
    /// The effective config AFTER the write.
    let config: EffectiveConfig
    let overrides: [String]
}
