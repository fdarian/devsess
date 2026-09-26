import AppKit
import SwiftUI

struct RunRow: View {
    let run: RunRecord
    let active: Bool
    let stopping: Bool
    let error: String?
    var snapshotMode = false
    let stop: () -> Void
    let restart: (ServiceRecord) -> Void

    private var path: String {
        let home = NSHomeDirectory()
        return run.canonicalCwd.hasPrefix(home + "/") ? "~" + run.canonicalCwd.dropFirst(home.count) : run.canonicalCwd
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 9) {
            HStack(alignment: .top, spacing: 9) {
                VStack(alignment: .leading, spacing: 3) {
                    HStack(alignment: .firstTextBaseline, spacing: 6) {
                        Text(run.projectName)
                            .font(.system(size: 14, weight: .semibold).width(.expanded))
                        Text(run.presetName)
                            .font(.system(size: 11))
                            .foregroundStyle(.secondary)
                    }
                    HStack(spacing: 0) {
                        Text((path as NSString).deletingLastPathComponent + "/")
                            .foregroundStyle(.tertiary)
                        Text((path as NSString).lastPathComponent)
                            .foregroundStyle(.secondary)
                    }
                    .font(.system(size: 10.5))
                    .lineLimit(1)
                    .truncationMode(.middle)
                    .help(run.canonicalCwd)
                }
                Spacer(minLength: 4)
                if active {
                    if stopping { Text("Stopping…").font(.caption).foregroundStyle(.secondary) }
                    else { HoldToStopButton(action: stop) }
                }
            }
            if !run.services.isEmpty {
                VStack(alignment: .leading, spacing: 11) {
                    ForEach(run.services) { service in
                        ServiceRow(service: service, active: active, snapshotMode: snapshotMode, restart: { restart(service) })
                    }
                }
                .padding(.leading, 15)
                .overlay(alignment: .leading) {
                    Rectangle().fill(Theme.lamp(run.state).opacity(0.35))
                        .frame(width: 1)
                        .padding(.leading, 18.5)
                        .padding(.vertical, 8)
                        .allowsHitTesting(false)
                }
            }
            if let error {
                Text(error).font(.caption).foregroundStyle(Theme.red)
            }
        }
        .padding(.vertical, 5)
        .opacity(active ? 1 : 0.6)
        .contextMenu {
            Button("Copy path") { NSPasteboard.general.clearContents(); NSPasteboard.general.setString(run.canonicalCwd, forType: .string) }
            Button("Reveal in Finder") { NSWorkspace.shared.activateFileViewerSelecting([URL(fileURLWithPath: run.canonicalCwd)]) }
            Button("Open in Terminal") {
                let process = Process()
                process.executableURL = URL(fileURLWithPath: "/usr/bin/open")
                process.arguments = ["-a", "Terminal", run.canonicalCwd]
                try? process.run()
            }
            Button("Copy devsess tail command") {
                NSPasteboard.general.clearContents()
                NSPasteboard.general.setString("devsess tail \(run.runId)", forType: .string)
            }
        }
    }
}
