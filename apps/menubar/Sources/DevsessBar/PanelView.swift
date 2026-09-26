import AppKit
import SwiftUI

struct PanelView: View {
    @Bindable var store: RunStore
    @Bindable var presentation: PanelPresentation
    var snapshotMode = false

    private var summary: String {
        let active = store.groups.active
        if active.isEmpty { return "Nothing running" }
        let running = active.filter { $0.glyphState == .ready }.count
        let starting = active.filter { $0.glyphState == .starting }.count
        let failed = active.filter { $0.glyphState == .failed }.count
        let parts = [
            running > 0 ? "\(running) \(running == 1 ? "server" : "servers") running" : nil,
            starting > 0 ? "\(starting) starting" : nil,
            failed > 0 ? "\(failed) \(failed == 1 ? "needs" : "need") attention" : nil
        ].compactMap { $0 }
        return parts.joined(separator: ", ")
    }

    private var initialContentHeight: CGFloat {
        let groups = store.groups
        let activeHeight = groups.active.reduce(CGFloat(0)) { height, run in
            height + estimatedHeight(for: run)
                + (store.actionErrors[run.id] == nil ? 0 : 40)
        }
        let separators = CGFloat(max(0, groups.active.count - 1)) * 27
        let empty = groups.active.isEmpty ? CGFloat(65) : 0
        let disclosure = groups.finished.isEmpty ? CGFloat(0) : 30
        let finished = presentation.finishedExpanded
            ? groups.finished.reduce(CGFloat(0)) { $0 + estimatedHeight(for: $1) + 10 }
            : 0
        return max(110, 34 + activeHeight + separators + empty + disclosure + finished)
    }

    private func estimatedHeight(for run: RunRecord) -> CGFloat {
        45 + CGFloat(run.services.count) * 35
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            VStack(spacing: 0) {
                HStack(spacing: 8) {
                    Text(summary)
                        .font(.system(size: 13, weight: .medium))
                        .frame(maxWidth: .infinity, alignment: .leading)
                    if snapshotMode {
                        Image(systemName: "ellipsis").frame(width: 20, height: 20)
                    } else {
                        Menu {
                            Button("Open logs folder") { NSWorkspace.shared.open(URL(fileURLWithPath: DaemonLocation.logsPath(), isDirectory: true)) }
                            Button("Quit") { NSApplication.shared.terminate(nil) }
                        } label: {
                            Image(systemName: "ellipsis")
                                .frame(width: 20, height: 20)
                        }
                        .menuStyle(.borderlessButton)
                        .menuIndicator(.hidden)
                        .fixedSize(horizontal: true, vertical: true)
                        .frame(width: 22, height: 22)
                        .help("More options")
                    }
                }
                .padding(.horizontal, 17)
                .padding(.vertical, 14)
                Divider()
            }
            .background(.regularMaterial)
            .zIndex(1)
            if snapshotMode {
                content
            } else {
                ScrollView(.vertical) { content }
                    .frame(height: min(initialContentHeight, 480))
                    .clipped()
            }
        }
        .frame(width: 360)
    }

    private var content: some View {
        VStack(alignment: .leading, spacing: 13) {
            if store.daemonDown {
                message("The devsess daemon isn't running. It starts with your next `dev start`.")
            } else if let error = store.statusError {
                message(error)
            } else if store.groups.active.isEmpty {
                message("Nothing running. Start a server with `dev start` in a project.")
            }
            ForEach(store.groups.active) { run in
                RunRow(run: run, active: true, stopping: store.stopping.contains(run.id), error: store.actionErrors[run.id], snapshotMode: snapshotMode, stop: { store.stop(run) }, restart: { store.restart($0, in: run) })
                if run.id != store.groups.active.last?.id { Divider() }
            }
            if !store.groups.finished.isEmpty {
                Button {
                    presentation.finishedExpanded.toggle()
                } label: {
                    Label {
                        Text("Recently stopped (\(store.groups.finished.count))")
                    } icon: {
                        Image(systemName: presentation.finishedExpanded ? "chevron.down" : "chevron.right")
                    }
                }
                .buttonStyle(.plain)
                .font(.system(size: 11))
                .foregroundStyle(.secondary)
                .padding(.top, 5)
                if presentation.finishedExpanded {
                    VStack(alignment: .leading, spacing: 10) {
                        ForEach(store.groups.finished) { run in
                            RunRow(run: run, active: false, stopping: false, error: nil, snapshotMode: snapshotMode, stop: {}, restart: { _ in })
                        }
                    }
                    .padding(.top, 7)
                }
            }
        }
        .padding(17)
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    private func message(_ text: String) -> some View {
        Text(text).font(.system(size: 12)).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
            .padding(.vertical, 15)
    }
}
