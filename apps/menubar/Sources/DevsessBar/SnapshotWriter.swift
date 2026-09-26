import AppKit
import SwiftUI

enum SnapshotWriter {
    @MainActor static func write(to directory: URL) throws {
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        let busy = RunStore()
        busy.runsForPreview(Fixtures.busy)
        try save(PanelView(store: busy, snapshotMode: true, pollingEnabled: false).background(Color(nsColor: .windowBackgroundColor)), as: "panel-busy.png", in: directory)
        try saveLivePanel(store: busy, as: "panel-live-busy.png", in: directory)
        guard let firstRun = Fixtures.busy.first else { throw DaemonError.invalidResponse }
        let single = RunStore()
        single.runsForPreview([firstRun])
        try saveLivePanel(store: single, as: "panel-live-single.png", in: directory)
        try save(PanelView(store: RunStore(), snapshotMode: true, pollingEnabled: false).background(Color(nsColor: .windowBackgroundColor)), as: "panel-empty.png", in: directory)
        let down = RunStore()
        down.downForPreview()
        try save(PanelView(store: down, snapshotMode: true, pollingEnabled: false).background(Color(nsColor: .windowBackgroundColor)), as: "panel-daemon-down.png", in: directory)

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

    @MainActor private static func saveLivePanel(store: RunStore, as name: String, in directory: URL) throws {
        let window = NSWindow(
            contentRect: CGRect(x: -10000, y: -10000, width: 360, height: 600),
            styleMask: [.borderless], backing: .buffered, defer: false
        )
        window.isOpaque = false
        window.backgroundColor = .clear
        window.hasShadow = false
        let host = NSHostingView(rootView: PanelView(store: store, pollingEnabled: false)
            .background(Color(nsColor: .windowBackgroundColor)))
        host.frame = CGRect(x: 0, y: 0, width: 360, height: 600)
        window.contentView = host
        window.orderBack(nil)
        defer { window.orderOut(nil); window.close() }

        for _ in 0..<4 {
            host.layoutSubtreeIfNeeded()
            RunLoop.main.run(until: Date().addingTimeInterval(0.03))
            let height = host.fittingSize.height
            guard height > 0, height <= 600 else { throw DaemonError.invalidResponse }
            let size = CGSize(width: 360, height: height)
            window.setContentSize(size)
            host.frame = CGRect(origin: .zero, size: size)
        }
        host.layoutSubtreeIfNeeded()
        guard let bitmap = host.bitmapImageRepForCachingDisplay(in: host.bounds) else {
            throw DaemonError.invalidResponse
        }
        host.cacheDisplay(in: host.bounds, to: bitmap)
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
