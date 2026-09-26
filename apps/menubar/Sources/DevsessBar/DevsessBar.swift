import AppKit
import SwiftUI

@main
struct DevsessBar: App {
    @NSApplicationDelegateAdaptor(DevsessAppDelegate.self) private var delegate

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
            } else if arguments.count == 2 && arguments[1] == "--selftest-panel" {
                Task { @MainActor in
                    do { try PanelSelfTest.run(); exit(0) }
                    catch { fputs("Panel self-test failed: \(error)\n", stderr); exit(1) }
                }
            } else {
                fputs("Usage: Devsess [--snapshot directory | --selftest-panel | --list]\n", stderr)
                exit(2)
            }
        }
    }

    var body: some Scene {
        Settings { EmptyView() }
    }
}

@MainActor final class DevsessAppDelegate: NSObject, NSApplicationDelegate {
    private var controller: StatusItemController?

    func applicationDidFinishLaunching(_ notification: Notification) {
        guard CommandLine.arguments.count == 1 else { return }
        controller = StatusItemController(store: RunStore())
    }

    func applicationDidResignActive(_ notification: Notification) {
        controller?.hide()
    }
}
