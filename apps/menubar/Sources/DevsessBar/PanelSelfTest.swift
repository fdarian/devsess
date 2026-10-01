import AppKit

enum PanelSelfTest {
    @MainActor static func run() throws {
        try ServiceRowClickSelfTest.run()
        for point in [CGPoint(x: 0, y: 0), CGPoint(x: 12, y: 12), CGPoint(x: 23.99, y: 23.99)] {
            guard ServiceRowGeometry.shouldArm(at: point, stopping: false, snapshotMode: false) else {
                throw PanelTestFailure("Stop zone does not arm at \(point)")
            }
        }
        for point in [CGPoint(x: 24, y: 12), CGPoint(x: 100, y: 12), CGPoint(x: 12, y: 24)] {
            guard !ServiceRowGeometry.shouldArm(at: point, stopping: false, snapshotMode: false) else {
                throw PanelTestFailure("Stop zone arms outside its bounds at \(point)")
            }
        }
        guard !ServiceRowGeometry.shouldArm(at: CGPoint(x: 12, y: 12), stopping: true, snapshotMode: false) else {
            throw PanelTestFailure("Disabled stop zone arms")
        }
        print("stop zone: \(ServiceRowGeometry.stopZoneWidth) × \(ServiceRowGeometry.height), pointer arming passed")
        let store = RunStore()
        store.runsForPreview(Fixtures.stress)
        let anchor = NSRect(x: -11500, y: -11100, width: 22, height: 22)
        let screen = NSRect(x: -12000, y: -12000, width: 1000, height: 1000)
        let controller = StatusItemController(store: store, showsStatusItem: false,
            testAnchor: anchor, testScreen: screen)
        defer { controller.close() }
        controller.orderBackForCapture()

        try check("many runs", controller: controller, top: anchor.minY - 4, centerX: anchor.midX)
        store.runsForPreview(Fixtures.busy)
        try check("few runs", controller: controller, top: anchor.minY - 4, centerX: anchor.midX)
        store.runsForPreview([])
        try check("empty", controller: controller, top: anchor.minY - 4, centerX: anchor.midX)
        store.runsForPreview(Fixtures.stress)
        try check("many runs restored", controller: controller, top: anchor.minY - 4, centerX: anchor.midX)
        let anchoredFrame = controller.panel.frame
        controller.panel.setFrame(anchoredFrame.offsetBy(dx: 31, dy: -19), display: false)
        try checkShadowFrame(controller)
        var resizedFrame = controller.panel.frame
        resizedFrame.size.height -= 40
        controller.panel.setFrame(resizedFrame, display: false)
        try checkShadowFrame(controller)
        controller.updateLayout()
        print("child shadow: direct moves and resizes passed")

        let smallScreen = NSRect(x: -12000, y: -11350, width: 1000, height: 350)
        let constrained = StatusItemController(store: store, showsStatusItem: false,
            testAnchor: anchor, testScreen: smallScreen)
        defer { constrained.close() }
        constrained.orderBackForCapture()
        try check("short screen", controller: constrained, top: anchor.minY - 4, centerX: anchor.midX)
        guard constrained.visiblePanelFrame.minY >= smallScreen.minY else {
            throw PanelTestFailure("Panel extends below the screen")
        }
    }

    @MainActor private static func check(_ name: String, controller: StatusItemController,
                                        top: CGFloat, centerX: CGFloat) throws {
        for _ in 0..<4 {
            RunLoop.main.run(until: Date().addingTimeInterval(0.03))
            controller.updateLayout()
        }
        let panel = controller.panel
        guard let content = panel.contentView else { throw PanelTestFailure("Missing panel content") }
        let frame = controller.visiblePanelFrame
        let expectedHeight = min(controller.host.intrinsicContentSize.height, controller.host.rootView.maximumHeight)
        guard abs(frame.maxY - top) < 1 else { throw PanelTestFailure("\(name): top moved to \(frame.maxY)") }
        guard abs(frame.height - expectedHeight) < 1 else {
            throw PanelTestFailure("\(name): height \(frame.height) differs from fitting \(expectedHeight)")
        }
        guard abs(frame.width - 300) < 1 else { throw PanelTestFailure("\(name): wrong panel width") }
        guard abs(frame.midX - centerX) < 1 else { throw PanelTestFailure("\(name): horizontal anchor moved") }
        guard !panel.hasShadow else { throw PanelTestFailure("\(name): WindowServer shadow is enabled") }
        guard panel.frame.size == content.bounds.size,
              controller.shadowPanel.parent == panel,
              controller.shadowPanel.isVisible,
              !controller.shadowPanel.hasShadow else {
            throw PanelTestFailure("\(name): panel bounds or child shadow configuration is incorrect")
        }
        let material = content
        guard abs(controller.host.frame.minY - material.bounds.minY) < 1,
              abs(controller.host.frame.height - material.bounds.height) < 1,
              abs(controller.host.frame.width - material.bounds.width) < 1 else {
            throw PanelTestFailure("\(name): hosting view does not fill the material content view")
        }
        let bitmap = try PanelCapture.bitmap(for: controller)
        let visible = controller.chrome.panelRect
        let shadow = controller.chrome.shadowView
        guard let shadowBitmap = shadow.bitmapImageRepForCachingDisplay(in: shadow.bounds) else {
            throw PanelTestFailure("\(name): could not render the custom shadow")
        }
        shadow.cacheDisplay(in: shadow.bounds, to: shadowBitmap)
        guard let interiorAlpha = shadowBitmap.colorAt(x: shadowBitmap.pixelsWide / 2,
            y: shadowBitmap.pixelsHigh / 2)?.alphaComponent, interiorAlpha == 0 else {
            throw PanelTestFailure("\(name): shadow darkens the glass interior")
        }
        let scaleX = CGFloat(bitmap.pixelsWide) / controller.chrome.bounds.width
        let scaleY = CGFloat(bitmap.pixelsHigh) / controller.chrome.bounds.height
        let shadowPoint = CGPoint(x: visible.minX - 10, y: visible.midY)
        guard let shadowAlpha = bitmap.colorAt(x: Int(shadowPoint.x * scaleX),
            y: Int((controller.chrome.bounds.maxY - shadowPoint.y) * scaleY))?.alphaComponent,
            shadowAlpha > 0, shadowAlpha <= 0.30 else {
            throw PanelTestFailure("\(name): missing or opaque custom shadow")
        }
        for cornerX in [visible.minX, visible.maxX] {
            for cornerY in [visible.minY, visible.maxY] {
                for dx in -3...2 {
                    for dy in -3...2 {
                        let point = CGPoint(x: cornerX + CGFloat(dx), y: cornerY + CGFloat(dy))
                        guard !controller.chrome.containsPanelPoint(point),
                              controller.chrome.hitTest(point) == nil else {
                            throw PanelTestFailure("\(name): rounded-corner margin hit-tests")
                        }
                        guard controller.shadowPanel.ignoresMouseEvents else {
                            throw PanelTestFailure("\(name): shadow margin is not click-through")
                        }
                        let x = Int(point.x * scaleX)
                        let y = Int((controller.chrome.bounds.maxY - point.y) * scaleY)
                        guard let alpha = bitmap.colorAt(x: x, y: y)?.alphaComponent,
                              let adjacent = bitmap.colorAt(x: x + 1, y: y)?.alphaComponent else {
                            throw PanelTestFailure("\(name): missing corner pixels")
                        }
                        guard alpha <= 0.30, abs(alpha - adjacent) <= 0.12 else {
                            throw PanelTestFailure("\(name): hard/opaque content outside corner at (\(x), \(y)): \(alpha), next=\(adjacent)")
                        }
                    }
                }
            }
        }
        guard controller.chrome.containsPanelPoint(CGPoint(x: visible.midX, y: visible.midY)) else {
            throw PanelTestFailure("\(name): visible panel is not interactive")
        }
        guard !panel.ignoresMouseEvents else { throw PanelTestFailure("\(name): panel ignores interior clicks") }
        try checkShadowFrame(controller)
        print("\(name): \(NSStringFromRect(frame)) fitting=\(expectedHeight)")
    }

    @MainActor private static func checkShadowFrame(_ controller: StatusItemController) throws {
        guard controller.shadowPanel.frame == PanelChromeGeometry.windowFrame(for: controller.panel.frame),
              controller.chrome.panelRect.size == controller.panel.frame.size else {
            throw PanelTestFailure("Child shadow does not follow the panel frame")
        }
    }
}

private struct PanelTestFailure: Error, CustomStringConvertible {
    let description: String
    init(_ description: String) { self.description = description }
}
