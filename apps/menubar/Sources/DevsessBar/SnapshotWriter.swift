import AppKit
import SwiftUI

enum SnapshotWriter {
    @MainActor static func write(to directory: URL) throws {
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        let busy = RunStore()
        busy.runsForPreview(Fixtures.busy)
        try save(PanelView(store: busy, snapshotMode: true).frame(height: 510, alignment: .top).background(Color(nsColor: .windowBackgroundColor)), as: "panel-busy.png", in: directory)
        try save(PanelView(store: RunStore(), snapshotMode: true).frame(height: 155, alignment: .top).background(Color(nsColor: .windowBackgroundColor)), as: "panel-empty.png", in: directory)
        let down = RunStore()
        down.downForPreview()
        try save(PanelView(store: down, snapshotMode: true).frame(height: 155, alignment: .top).background(Color(nsColor: .windowBackgroundColor)), as: "panel-daemon-down.png", in: directory)

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
    }

    @MainActor private static func save<V: View>(_ view: V, as name: String, in directory: URL) throws {
        let renderer = ImageRenderer(content: view.environment(\.colorScheme, .light))
        renderer.scale = 2
        renderer.isOpaque = true
        guard let image = renderer.nsImage,
              let tiff = image.tiffRepresentation,
              let bitmap = NSBitmapImageRep(data: tiff),
              let png = bitmap.representation(using: .png, properties: [:]) else { throw DaemonError.invalidResponse }
        try png.write(to: directory.appendingPathComponent(name))
    }
}
