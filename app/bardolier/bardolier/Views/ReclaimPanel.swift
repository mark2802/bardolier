//
//  ReclaimPanel.swift
//  Bardolier
//
//  Reclaim disk (app-spec.md §9).
//
//  The list is `status`'s `orphaned_volumes` — named volumes and leftover
//  service data directories (phase 19) no manifest claims any more, which the
//  CLI DERIVES rather than records (CLAUDE.md). Nothing here
//  decides what is reclaimable; it renders what was reported and asks the CLI
//  to remove what the user picks.
//
//  Nothing happens automatically, and that is the point (§9): detaching a
//  service or deleting a project keeps the data, so an orphan is a deliberate
//  leftover, not a leak. It sits here, with its size, until someone says so.
//  Both Delete and Delete all confirm and name what they will destroy — the
//  client passes `--force`, so this is the only confirmation there is.
//

import SwiftUI

struct ReclaimPanel: View {
    @EnvironmentObject private var store: BardolierStore

    /// The root menu's confirmation, so a destructive answer is asked the same
    /// way everywhere.
    var confirm: (ConfirmationRequest) -> Void
    var back: () -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            PanelHeader(title: "Reclaim disk", back: back)

            if store.orphanedVolumes.isEmpty {
                Text(emptyMessage)
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .padding(.horizontal, 10)
                    .padding(.bottom, 8)
            } else {
                ScrollView {
                    VStack(alignment: .leading, spacing: 0) {
                        ForEach(store.orphanedVolumes) { volume in
                            row(for: volume)
                        }
                    }
                }
                .frame(maxHeight: 300)

                Divider().padding(.vertical, 4)

                MenuTextRow(
                    title: "Delete all (\(BardolierFormat.bytes(totalBytes)))",
                    systemImage: "trash",
                    isDisabled: store.isBusy || store.isDegraded
                ) {
                    confirm(deleteAllConfirmation)
                }
            }

            if let error = store.lastError {
                ErrorBanner(failure: error) { store.clearError() }
                    .padding(.bottom, 6)
            }
            if let notice = store.notice {
                NoticeBanner(text: notice) { store.clearNotice() }
                    .padding(.bottom, 6)
            }
        }
        .padding(.bottom, 6)
    }

    private var emptyMessage: String {
        store.isDegraded
            ? "Orphans can only be listed with the SSD mounted and Docker running."
            : "Nothing to reclaim. Detaching a service leaves its data directory here."
    }

    private var totalBytes: Int {
        store.orphanedVolumes.reduce(0) { $0 + $1.sizeBytes }
    }

    private func row(for volume: OrphanedVolume) -> some View {
        MenuRow(isDisabled: store.isBusy || store.isDegraded) {
            confirm(deleteConfirmation(for: volume))
        } content: {
            HStack(spacing: 6) {
                Image(systemName: "externaldrive.badge.minus")
                    .font(.system(size: 11))
                    .foregroundStyle(.secondary)
                VStack(alignment: .leading, spacing: 1) {
                    Text(volume.name).font(.caption.monospaced())
                    Text("\(volume.sizeHuman) · last used by \(volume.lastProject ?? "an unknown project")")
                        .font(.caption2)
                        .foregroundStyle(.tertiary)
                }
                Spacer(minLength: 0)
                Image(systemName: "trash").font(.system(size: 10)).foregroundStyle(.secondary)
            }
        }
    }

    private func deleteConfirmation(for volume: OrphanedVolume) -> ConfirmationRequest {
        ConfirmationRequest(
            title: "Delete \(volume.name)?",
            detail: "\(volume.sizeHuman) of data is destroyed. There is no undo, and no copy of it anywhere else.",
            confirmLabel: "Delete",
            toggleLabel: nil,
            perform: { _ in
                Task { await store.reclaim(volume: volume.name) }
            }
        )
    }

    private var deleteAllConfirmation: ConfirmationRequest {
        let volumes = store.orphanedVolumes
        return ConfirmationRequest(
            title: "Delete all \(volumes.count) orphans?",
            detail: "\(BardolierFormat.bytes(totalBytes)) of data is destroyed. "
                + "A volume that turns out to still be in use is skipped and reported.",
            confirmLabel: "Delete all",
            toggleLabel: nil,
            perform: { _ in
                Task { await store.reclaimAll(volumes: volumes) }
            }
        )
    }
}
