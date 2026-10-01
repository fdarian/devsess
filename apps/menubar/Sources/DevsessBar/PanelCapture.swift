import AppKit

enum PanelCapture {
    @MainActor static func bitmap(for controller: StatusItemController) throws -> NSBitmapImageRep {
        guard let material = controller.panel.contentView,
              let foreground = material.bitmapImageRepForCachingDisplay(in: material.bounds),
              let bitmap = controller.chrome.bitmapImageRepForCachingDisplay(in: controller.chrome.bounds),
              let context = NSGraphicsContext(bitmapImageRep: bitmap) else {
            throw DaemonError.invalidResponse
        }
        material.cacheDisplay(in: material.bounds, to: foreground)
        controller.chrome.cacheDisplay(in: controller.chrome.bounds, to: bitmap)
        // View caching does not include child windows; composite their native captures.
        NSGraphicsContext.saveGraphicsState()
        defer { NSGraphicsContext.restoreGraphicsState() }
        NSGraphicsContext.current = context
        foreground.draw(in: controller.chrome.panelRect)
        return bitmap
    }
}
