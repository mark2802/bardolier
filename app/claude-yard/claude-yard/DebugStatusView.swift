//
//  DebugStatusView.swift
//  claude-yard
//
//  Phase 5's deliverable UI: a dump of the decoded `cproj status --json`.
//
//  It exists to prove one thing before any real menu is built — that what the
//  CLI emits is what the models decode, field for field, against a live SSD
//  and a live Docker. Ports especially: the host port shown here is the
//  debugging tap you paste into a GUI client, and the container port next to it
//  is what the dev app actually connects to over the internal Docker network
//  (cli-spec.md §5). Seeing both, correctly, is the done-check.
//
//  The real menu (app-spec.md §5) replaces this view in Phase 6. The rendering
//  helpers below deliberately hold no logic worth keeping — they only lay out
//  values the CLI already decided.
//

import AppKit
import Foundation
import SwiftUI

struct DebugStatusView: View {
    @EnvironmentObject private var store: CprojStore

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            header

            if let error = store.lastError {
                FailureBanner(failure: error)
            }

            ScrollView {
                VStack(alignment: .leading, spacing: 16) {
                    if let status = store.status {
                        StatusDumpView(status: status)
                    } else if store.lastError == nil {
                        Text("Loading…").foregroundStyle(.secondary)
                    }

                    if let doctor = store.doctor {
                        DoctorDumpView(doctor: doctor)
                    }
                }
                .padding(.trailing, 4)
            }
            .frame(maxHeight: 420)

            Divider()
            footer
        }
        .padding(12)
        .frame(width: 380)
        .task { await store.appear() }
    }

    private var header: some View {
        HStack {
            Text("claude-yard").font(.headline)
            Spacer()
            if store.isBusy {
                ProgressView().controlSize(.small)
            }
            Button("Refresh") {
                Task { await store.refresh(force: true) }
            }
            .disabled(store.isBusy)
        }
    }

    private var footer: some View {
        HStack(alignment: .firstTextBaseline) {
            VStack(alignment: .leading, spacing: 2) {
                Text(store.executablePath ?? "cproj not found")
                    .font(.caption.monospaced())
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
                    .truncationMode(.middle)
                if let refreshed = store.lastRefresh {
                    Text("status taken \(refreshed.formatted(date: .omitted, time: .standard))")
                        .font(.caption2)
                        .foregroundStyle(.tertiary)
                }
            }
            Spacer()
            Button("Quit") { NSApplication.shared.terminate(nil) }
                .keyboardShortcut("q")
        }
    }
}

// MARK: - status

struct StatusDumpView: View {
    let status: CprojStatus

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            Section2("Environment") {
                Row("SSD", status.ssd.mounted ? "mounted" : "not mounted", ok: status.ssd.mounted)
                Row("root", status.ssd.root)
                Row("Docker", status.docker.available ? "available" : "unavailable", ok: status.docker.available)
            }

            Section2("Projects (\(status.projects.count))") {
                if status.projects.isEmpty {
                    Text("none").font(.caption).foregroundStyle(.secondary)
                }
                ForEach(status.projects) { project in
                    ProjectDumpView(project: project)
                }
            }

            Section2("Orphaned volumes (\(status.orphanedVolumes.count))") {
                if status.orphanedVolumes.isEmpty {
                    Text("none").font(.caption).foregroundStyle(.secondary)
                }
                ForEach(status.orphanedVolumes) { volume in
                    Row(volume.name, "\(volume.sizeHuman) · \(volume.lastProject ?? "unattributed")")
                }
            }
        }
    }
}

struct ProjectDumpView: View {
    let project: CprojProject

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack(spacing: 6) {
                Circle()
                    .fill(project.state.isUp ? Color.green : Color.secondary)
                    .frame(width: 8, height: 8)
                Text(project.name).font(.system(.body, design: .monospaced))
                Text(project.archetype.display).font(.caption).foregroundStyle(.secondary)
                Spacer()
                Text(project.state.rawValue).font(.caption).foregroundStyle(.secondary)
            }

            Text(project.devContainer ?? "no dev container")
                .font(.caption2.monospaced())
                .foregroundStyle(.tertiary)

            ForEach(project.services) { service in
                HStack(spacing: 6) {
                    Circle()
                        .fill(service.state == .running ? Color.green : Color.secondary)
                        .frame(width: 6, height: 6)
                    Text(service.display).font(.caption)
                    Spacer()
                    // host → container: the tap, then what the app connects to.
                    Text("\(service.hostPort) → \(service.containerPort)")
                        .font(.caption.monospaced())
                    Text(service.connectionHint)
                        .font(.caption2.monospaced())
                        .foregroundStyle(.secondary)
                        .lineLimit(1)
                        .truncationMode(.middle)
                }
                .padding(.leading, 14)
            }
        }
        .padding(6)
        .background(.quaternary.opacity(0.4), in: RoundedRectangle(cornerRadius: 6))
    }
}

// MARK: - doctor

struct DoctorDumpView: View {
    let doctor: DoctorOutput

    var body: some View {
        Section2("Doctor \(doctor.ok ? "· all clear" : "· needs attention")") {
            ForEach(doctor.findings) { finding in
                VStack(alignment: .leading, spacing: 1) {
                    Row(finding.title, finding.ok ? "ok" : "failed", ok: finding.ok)
                    Text(finding.detail).font(.caption2).foregroundStyle(.secondary)
                    if let remedy = finding.remedy {
                        Text(remedy).font(.caption2).foregroundStyle(.orange)
                    }
                }
            }
        }
    }
}

// MARK: - errors (app-spec.md §13)

struct FailureBanner: View {
    let failure: CprojFailure

    var body: some View {
        VStack(alignment: .leading, spacing: 2) {
            Text(failure.errorDescription ?? "cproj failed").font(.callout.bold())
            if let reason = failure.failureReason {
                Text(reason).font(.caption).foregroundStyle(.secondary)
            }
            if let suggestion = failure.recoverySuggestion {
                Text(suggestion).font(.caption2.monospaced()).foregroundStyle(.secondary).textSelection(.enabled)
            }
            // EJECT_BLOCKED's holders ride on the error, not a second call (§10).
            ForEach(failure.holders) { holder in
                Text("· \(holder.command) (pid \(holder.pid))").font(.caption2)
            }
        }
        .padding(8)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(.red.opacity(0.12), in: RoundedRectangle(cornerRadius: 6))
    }
}

// MARK: - small layout helpers

/// A titled block. Named `Section2` to stay out of SwiftUI's `Section`'s way.
struct Section2<Content: View>: View {
    let title: String
    let content: Content

    init(_ title: String, @ViewBuilder content: () -> Content) {
        self.title = title
        self.content = content()
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(title.uppercased())
                .font(.caption2.weight(.semibold))
                .foregroundStyle(.secondary)
            content
        }
    }
}

struct Row: View {
    let label: String
    let value: String
    let ok: Bool?

    init(_ label: String, _ value: String, ok: Bool? = nil) {
        self.label = label
        self.value = value
        self.ok = ok
    }

    var body: some View {
        HStack {
            Text(label).font(.caption)
            Spacer()
            Text(value)
                .font(.caption.monospaced())
                .foregroundStyle(ok == false ? Color.red : .primary)
                .lineLimit(1)
                .truncationMode(.middle)
        }
    }
}

// MARK: - previews

#if DEBUG
/// Captured from a real `cproj … --json` run against a scratch SSD root, with
/// the paths shortened and `myapp` flipped to `running` so the preview shows
/// both states. Decoding these is the cheapest check that the models still
/// match the frozen schemas — paste a fresh capture in when a schema grows a
/// field.
enum CprojFixtures {
    static let statusJSON = """
    {
      "ssd": { "mounted": true, "root": "/Volumes/ssd/claude-projects" },
      "docker": { "available": true },
      "projects": [
        {
          "name": "myapp",
          "archetype": "web",
          "state": "running",
          "services": [
            {
              "key": "postgres",
              "display": "PostgreSQL",
              "state": "running",
              "host_port": 5432,
              "container_port": 5432,
              "connection_hint": "postgresql://localhost:5432"
            },
            {
              "key": "redis",
              "display": "Redis",
              "state": "stopped",
              "host_port": 6379,
              "container_port": 6379,
              "connection_hint": "redis://localhost:6379"
            }
          ],
          "dev_container": "cproj-myapp"
        },
        {
          "name": "otherapp",
          "archetype": "library",
          "state": "stopped",
          "services": [],
          "dev_container": null
        }
      ],
      "orphaned_volumes": [
        {
          "name": "oldapp_pgdata",
          "size_bytes": 20971520,
          "size_human": "20 MB",
          "last_project": "oldapp"
        }
      ]
    }
    """

    static let doctorJSON = """
    {
      "ok": false,
      "findings": [
        { "id": "config", "title": "Config", "ok": true,
          "detail": "Loaded ~/.config/cproj/config.yml. ssd_root=/Volumes/ssd/claude-projects, ssd_volume=/Volumes/ssd, terminal=Terminal" },
        { "id": "ssd", "title": "SSD mounted", "ok": true,
          "detail": "/Volumes/ssd/claude-projects is readable (volume /Volumes/ssd)." },
        { "id": "docker", "title": "Docker daemon", "ok": true,
          "detail": "The Docker daemon responded." },
        { "id": "base_images", "title": "Base images", "ok": false,
          "detail": "Missing: claude-ios, claude-and.",
          "remedy": "Run `cproj build` to build the missing base images." },
        { "id": "catalogue", "title": "Service catalogue", "ok": true,
          "detail": "cli/defaults/services.yml (bundled) defines 3 services: mongo, postgres, redis." },
        { "id": "manifests", "title": "Project manifests", "ok": true,
          "detail": "2 projects under /Volumes/ssd/claude-projects." }
      ]
    }
    """

    static func decode<T: Decodable>(_ json: String, as type: T.Type = T.self) -> T {
        // A fixture that doesn't decode is a broken model, and a preview that
        // crashes says so louder than one that silently renders nothing.
        try! CprojClient.decoder.decode(T.self, from: Data(json.utf8))
    }

    static var status: CprojStatus { decode(statusJSON) }
    static var doctor: DoctorOutput { decode(doctorJSON) }
}

#Preview("Status dump") {
    ScrollView {
        VStack(alignment: .leading, spacing: 16) {
            StatusDumpView(status: CprojFixtures.status)
            DoctorDumpView(doctor: CprojFixtures.doctor)
        }
        .padding(12)
    }
    .frame(width: 380, height: 520)
}

#Preview("Failure banner") {
    VStack(spacing: 8) {
        FailureBanner(failure: .cli(CprojErrorBody(
            code: .projectRunning,
            message: "`myapp` is running. Stop it before changing its services.",
            details: nil
        )))
        FailureBanner(failure: .cli(CprojErrorBody(
            code: .ejectBlocked,
            message: "/Volumes/ssd is still held by 2 process(es).",
            details: CprojErrorDetails(
                holders: [
                    SsdHolder(pid: 431, command: "Xcode", user: "mark", paths: ["/Volumes/ssd/claude-projects/myapp"]),
                    SsdHolder(pid: 902, command: "zsh", user: "mark", paths: ["/Volumes/ssd"]),
                ],
                reason: nil
            )
        )))
        FailureBanner(failure: .executableNotFound(searched: CprojExecutable.searchedLocations))
    }
    .padding(12)
    .frame(width: 380)
}
#endif
