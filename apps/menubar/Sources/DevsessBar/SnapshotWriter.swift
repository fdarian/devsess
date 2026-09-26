import AppKit
import SwiftUI

enum SnapshotWriter {
    @MainActor static func write(to directory: URL) throws {
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        let busy = RunStore()
        busy.runsForPreview(Fixtures.busy)
        try save(PanelView(store: busy, presentation: PanelPresentation(), snapshotMode: true).background(Color(nsColor: .windowBackgroundColor)), as: "panel-busy.png", in: directory)
        try saveLivePanel(store: busy, as: "panel-live-busy.png", in: directory)
        guard let firstRun = Fixtures.busy.first else { throw DaemonError.invalidResponse }
        let single = RunStore()
        single.runsForPreview([firstRun])
        try saveLivePanel(store: single, as: "panel-live-single.png", in: directory)
        let stress = RunStore()
        stress.runsForPreview(Fixtures.stress)
        try saveLivePanel(store: stress, as: "panel-live-stress.png", in: directory)
        try saveLivePanel(store: stress, expanded: true, as: "panel-live-stress-expanded.png", in: directory)
        try save(PanelView(store: RunStore(), presentation: PanelPresentation(), snapshotMode: true).background(Color(nsColor: .windowBackgroundColor)), as: "panel-empty.png", in: directory)
        let down = RunStore()
        down.downForPreview()
        try save(PanelView(store: down, presentation: PanelPresentation(), snapshotMode: true).background(Color(nsColor: .windowBackgroundColor)), as: "panel-daemon-down.png", in: directory)

        let variants: [(String, [JackState], Bool)] = [
            ("Idle", [], false), ("One", [.ready], false),
            ("Three", [.ready, .starting, .failed], false),
            ("Six", [.ready, .ready, .ready, .starting, .failed, .ready], false),
            ("Starting", [.starting], false), ("Failed", [.failed], false),
            ("Daemon down", [], true)
        ]
        let icons = VStack(spacing: 0) {
            ForEach([Color.white, Color.black], id: \.self) { background in
                HStack(spacing: 18) {
                    ForEach(variants.indices, id: \.self) { index in
                        VStack(spacing: 8) {
                            JackGlyph(states: variants[index].1, daemonDown: variants[index].2)
                                .frame(width: 56, height: 22)
                            Text(variants[index].0).font(.system(size: 10))
                        }
                    }
                }
                .foregroundStyle(background == .white ? .black : .white)
                .environment(\.colorScheme, background == .white ? .light : .dark)
                .padding(18)
                .frame(maxWidth: .infinity)
                .background(background)
            }
        }
        try save(icons, as: "icons.png", in: directory)
        try save(icons, as: "icons-1x.png", in: directory, scale: 1)
    }

    @MainActor private static func saveLivePanel(store: RunStore, expanded: Bool = false, as name: String, in directory: URL) throws {
        let controller = StatusItemController(store: store, showsStatusItem: false,
            testAnchor: NSRect(x: -11500, y: -11100, width: 22, height: 22),
            testScreen: NSRect(x: -12000, y: -12000, width: 1000, height: 1000))
        controller.presentation.finishedExpanded = expanded
        controller.updateLayout()
        controller.panel.orderBack(nil)
        defer { controller.panel.orderOut(nil); controller.panel.close() }
        for _ in 0..<3 {
            RunLoop.main.run(until: Date().addingTimeInterval(0.03))
            controller.updateLayout()
        }
        guard let content = controller.panel.contentView,
              let bitmap = content.bitmapImageRepForCachingDisplay(in: content.bounds) else {
            throw DaemonError.invalidResponse
        }
        content.cacheDisplay(in: content.bounds, to: bitmap)
        guard let png = bitmap.representation(using: .png, properties: [:]) else {
            throw DaemonError.invalidResponse
        }
        try png.write(to: directory.appendingPathComponent(name))
    }

    @MainActor private static func save<V: View>(_ view: V, as name: String, in directory: URL, scale: CGFloat = 2) throws {
        let renderer = ImageRenderer(content: view.environment(\.colorScheme, .light))
        renderer.scale = scale
        renderer.isOpaque = true
        guard let image = renderer.nsImage,
              let tiff = image.tiffRepresentation,
              let bitmap = NSBitmapImageRep(data: tiff),
              let png = bitmap.representation(using: .png, properties: [:]) else { throw DaemonError.invalidResponse }
        try png.write(to: directory.appendingPathComponent(name))
    }
}
