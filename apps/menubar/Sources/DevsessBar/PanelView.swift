import AppKit
import SwiftUI

struct PanelView: View {
    @Bindable var store: RunStore
    var snapshotMode = false
    @LegacyState private var showFinished = false

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

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack {
                Text(summary).font(.system(size: 13, weight: .medium))
                Spacer()
                if snapshotMode {
                    Image(systemName: "ellipsis").frame(width: 20, height: 20)
                } else {
                    Menu {
                        Button("Open logs folder") { NSWorkspace.shared.open(URL(fileURLWithPath: DaemonLocation.logsPath(), isDirectory: true)) }
                        Button("Quit") { NSApplication.shared.terminate(nil) }
                    } label: {
                        Image(systemName: "ellipsis").frame(width: 20, height: 20)
                    }
                    .menuStyle(.borderlessButton)
                    .help("More options")
                }
            }
            .padding(.horizontal, 17)
            .padding(.vertical, 14)
            Divider()
            if snapshotMode {
                content
            } else {
                ScrollView { content }
                    .frame(maxHeight: 480)
            }
        }
        .frame(width: 360)
        .onAppear { if !snapshotMode { store.panelOpen = true; store.start() } }
        .onDisappear { if !snapshotMode { store.panelOpen = false } }
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
                        DisclosureGroup("Recently stopped (\(store.groups.finished.count))", isExpanded: $showFinished) {
                            VStack(alignment: .leading, spacing: 10) {
                                ForEach(store.groups.finished) { run in
                                    RunRow(run: run, active: false, stopping: false, error: nil, snapshotMode: snapshotMode, stop: {}, restart: { _ in })
                                }
                            }.padding(.top, 7)
                        }
                        .font(.system(size: 11))
                        .foregroundStyle(.secondary)
                        .padding(.top, 5)
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
