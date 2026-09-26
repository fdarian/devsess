import AppKit
import SwiftUI

@main
struct DevsessBar: App {
    @LegacyState private var store = RunStore()

    init() {
        let arguments = CommandLine.arguments
        if arguments.count > 1 {
            if arguments.count == 3 && arguments[1] == "--snapshot" {
                Task { @MainActor in
                    do { try SnapshotWriter.write(to: URL(fileURLWithPath: arguments[2], isDirectory: true)); exit(0) }
                    catch { fputs("Snapshot failed: \(error)\n", stderr); exit(1) }
                }
            } else if arguments.count == 2 && arguments[1] == "--list" {
                Task {
                    do {
                        for run in try await DaemonClient().listRuns() {
                            print("\(run.projectName)/\(run.presetName) \(run.state.rawValue) \(run.canonicalCwd)")
                        }
                        exit(0)
                    } catch { fputs("\(error.localizedDescription)\n", stderr); exit(1) }
                }
            } else {
                fputs("Usage: Devsess [--snapshot directory | --list]\n", stderr)
                exit(2)
            }
        }
    }

    var body: some Scene {
        MenuBarExtra {
            PanelView(store: store)
        } label: {
            Image(nsImage: MenuBarIcon.image(states: store.groups.active.map(\.glyphState), daemonDown: store.daemonDown))
                .onAppear { store.start() }
        }
        .menuBarExtraStyle(.window)
    }
}
