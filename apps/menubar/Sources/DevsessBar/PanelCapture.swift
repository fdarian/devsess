import AppKit

enum PanelCapture {
    @MainActor static func bitmap(for controller: StatusItemController) throws -> NSBitmapImageRep {
        guard let content = controller.panel.contentView,
              let bitmap = content.bitmapImageRepForCachingDisplay(in: content.bounds) else {
            throw DaemonError.invalidResponse
        }
        content.cacheDisplay(in: content.bounds, to: bitmap)
        return bitmap
    }
}
