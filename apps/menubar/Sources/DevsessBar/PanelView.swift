import AppKit
import SwiftUI

struct PanelView: View {
    @Bindable var store: RunStore
    var snapshotMode = false
    var previewState: RowPreviewState = .normal
    var maximumHeight: CGFloat = 530
    var stopRun: ((RunRecord) -> Void)?
    var openURL: (URL) -> Void = { NSWorkspace.shared.open($0) }

    private var sectionsHeight: CGFloat {
        let runs = store.groups.active
        if runs.isEmpty { return 30 }
        return runs.reduce(0) { height, run in
            height + 20 + CGFloat(run.services.count) * 24
                + (store.actionErrors[run.id] == nil ? 0 : 28)
        } + CGFloat(max(0, runs.count - 1)) * 6
    }

    var body: some View {
        VStack(spacing: 0) {
            ScrollView(.vertical) {
                VStack(alignment: .leading, spacing: 6) {
                    if store.daemonDown {
                        message("The devsess daemon isn't running")
                    } else if let error = store.statusError {
                        message(error)
                    } else if store.groups.active.isEmpty {
                        message("No servers running")
                    }
                    ForEach(store.groups.active) { run in
                        RunRow(run: run, stopping: store.stopping.contains(run.id),
                            error: store.actionErrors[run.id],
                            claudeSessions: store.claudeByCwd[run.canonicalCwd] ?? [],
                            snapshotMode: snapshotMode, previewState: previewState,
                            stop: {
                                if let stopRun { stopRun(run) } else { store.stop(run) }
                            },
                            restart: { store.restart($0, in: run) }, openURL: openURL)
                    }
                }
                .frame(maxWidth: .infinity, alignment: .leading)
            }
            .frame(height: min(sectionsHeight, max(30, maximumHeight - 87)))
            .scrollIndicators(.automatic)
            .scrollContentBackground(.hidden)

            Rectangle()
                .fill(Color(nsColor: .separatorColor))
                .frame(height: 1)
                .padding(.horizontal, 9)
                .padding(.vertical, 5)
            action("Stop All Servers", enabled: !store.groups.active.isEmpty) {
                for run in store.groups.active where !store.stopping.contains(run.id) { store.stop(run) }
            }
            action("Open Logs Folder") {
                NSWorkspace.shared.open(URL(fileURLWithPath: DaemonLocation.logsPath(), isDirectory: true))
            }
            action("Quit devsess", shortcut: "⌘Q") { NSApplication.shared.terminate(nil) }
        }
        .padding(5)
        .frame(width: 300)
    }

    private func message(_ value: String) -> some View {
        Text(value)
            .font(.system(size: 13))
            .foregroundStyle(Color(nsColor: .secondaryLabelColor))
            .frame(maxWidth: .infinity, alignment: .leading)
            .frame(height: 30)
            .padding(.horizontal, 9)
    }

    private func action(_ title: String, shortcut: String? = nil, enabled: Bool = true,
                        perform: @escaping () -> Void) -> some View {
        MenuActionRow(title: title, shortcut: shortcut, enabled: enabled, snapshotMode: snapshotMode, perform: perform)
    }
}

private struct MenuActionRow: View {
    let title: String
    let shortcut: String?
    let enabled: Bool
    let snapshotMode: Bool
    let perform: () -> Void
    @LegacyState private var hovered = false

    var body: some View {
        Button(action: perform) {
            HStack {
                Text(title)
                Spacer()
                if let shortcut { Text(shortcut).foregroundStyle(hovered ? .white : Color(nsColor: .secondaryLabelColor)) }
            }
            .font(.system(size: 13))
            .foregroundStyle(hovered ? .white : Color(nsColor: .labelColor))
            .padding(.horizontal, 9)
            .frame(height: 22)
            .background(hovered ? Color(nsColor: .selectedContentBackgroundColor) : .clear,
                        in: RoundedRectangle(cornerRadius: 5))
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .disabled(!enabled || snapshotMode)
        .onHover { hovered = $0 && enabled && !snapshotMode }
    }
}
