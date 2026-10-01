import AppKit
import SwiftUI

enum SnapshotWriter {
    @MainActor static func write(to directory: URL) throws {
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        let busy = RunStore()
        busy.runsForPreview(Fixtures.busy)
        busy.claudeSessionsForPreview(Fixtures.claudeSessions)
        guard let firstRun = Fixtures.busy.first else { throw DaemonError.invalidResponse }
        let single = RunStore()
        single.runsForPreview([firstRun])
        let stress = RunStore()
        stress.runsForPreview(Fixtures.stress)
        let down = RunStore()
        down.downForPreview()
        let twoServices = RunStore()
        guard let twoServiceRun = Fixtures.busy.first(where: { $0.services.count == 2 }) else {
            throw DaemonError.invalidResponse
        }
        twoServices.runsForPreview([twoServiceRun])
        twoServices.claudeSessionsForPreview(Fixtures.claudeSessions)

        for appearance: NSAppearance.Name in [.aqua, .darkAqua] {
            let suffix = appearance == .aqua ? "light" : "dark"
            try savePanel(store: busy, appearance: appearance, as: "panel-busy-\(suffix).png", in: directory)
            try savePanel(store: single, appearance: appearance, as: "panel-single-\(suffix).png", in: directory)
            try savePanel(store: stress, appearance: appearance, as: "panel-stress-\(suffix).png", in: directory)
            try savePanel(store: RunStore(), appearance: appearance, as: "panel-empty-\(suffix).png", in: directory)
            try savePanel(store: down, appearance: appearance, as: "panel-daemon-down-\(suffix).png", in: directory)
            try savePanel(store: twoServices, appearance: appearance, previewState: .hovered,
                          as: "panel-hovered-\(suffix).png", in: directory)
            try savePanel(store: twoServices, appearance: appearance, previewState: .stopArmed,
                          as: "panel-stop-armed-\(suffix).png", in: directory)
        }

        let variants: [(String, Int, Bool)] = [
            ("Idle", 0, false), ("One", 1, false), ("Two", 2, false),
            ("Three", 3, false), ("Twelve", 12, false), ("Daemon down", 0, true)
        ]
        let icons = VStack(spacing: 0) {
            ForEach([Color.white, Color.black], id: \.self) { background in
                HStack(spacing: 18) {
                    ForEach(variants.indices, id: \.self) { index in
                        VStack(spacing: 8) {
                            HStack(spacing: 4) {
                                TerminalGlyph(idle: variants[index].1 == 0 || variants[index].2)
                                if let count = MenuBarIcon.count(for: variants[index].1, daemonDown: variants[index].2) {
                                    Text("\(count)").font(.system(size: 12, weight: .medium)).monospacedDigit()
                                }
                            }
                            .frame(width: 52, height: 22)
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

    @MainActor private static func savePanel(store: RunStore, appearance: NSAppearance.Name,
                                             previewState: RowPreviewState = .normal,
                                             as name: String, in directory: URL) throws {
        let controller = StatusItemController(store: store, showsStatusItem: false,
            testAnchor: NSRect(x: -11500, y: -11100, width: 22, height: 22),
            testScreen: NSRect(x: -12000, y: -12000, width: 1000, height: 1000))
        controller.panel.appearance = NSAppearance(named: appearance)
        controller.host.rootView = PanelView(store: store, snapshotMode: true, previewState: previewState)
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
        let renderer = ImageRenderer(content: view)
        renderer.scale = scale
        renderer.isOpaque = true
        guard let image = renderer.nsImage,
              let tiff = image.tiffRepresentation,
              let bitmap = NSBitmapImageRep(data: tiff),
              let png = bitmap.representation(using: .png, properties: [:]) else { throw DaemonError.invalidResponse }
        try png.write(to: directory.appendingPathComponent(name))
    }
}
