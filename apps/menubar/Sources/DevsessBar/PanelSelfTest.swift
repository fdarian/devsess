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

        let smallScreen = NSRect(x: -12000, y: -11350, width: 1000, height: 350)
        let constrained = StatusItemController(store: store, showsStatusItem: false,
            testAnchor: anchor, testScreen: smallScreen)
        defer { constrained.close() }
        constrained.orderBackForCapture()
        try check("short screen", controller: constrained, top: anchor.minY - 4, centerX: anchor.midX)
        guard constrained.visiblePanelFrame.minY >= smallScreen.minY else {
            throw PanelTestFailure("Panel extends below the screen")
        }
        store.runsForPreview(Fixtures.busy)
        controller.panel.appearance = NSAppearance(named: .darkAqua)
        try check("dark appearance", controller: controller, top: anchor.minY - 4, centerX: anchor.midX)
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
        guard panel.hasShadow, !panel.isOpaque, panel.backgroundColor.alphaComponent == 0,
              !panel.styleMask.contains(.fullSizeContentView), panel.childWindows?.isEmpty != false else {
            throw PanelTestFailure("\(name): window backing or shadow configuration is incorrect")
        }
        guard panel.frame.size == content.bounds.size,
              content === controller.container, content.subviews.count == 1,
              content.subviews.first === controller.effectView,
              controller.effectView.frame == content.bounds,
              let layer = content.layer, layer.masksToBounds,
              layer.cornerRadius == PanelChromeGeometry.cornerRadius, layer.cornerCurve == .continuous,
              layer.backgroundColor == nil || layer.backgroundColor?.alpha == 0 else {
            throw PanelTestFailure("\(name): panel is not a single clear clipped container")
        }
        let views = descendants(of: content)
        let materialViews = views.filter { $0 is NSVisualEffectView }
        if #available(macOS 26, *) {
            let glassViews = views.compactMap { $0 as? NSGlassEffectView }
            guard glassViews.count == 1, materialViews.isEmpty,
                  glassViews.first?.cornerRadius == PanelChromeGeometry.cornerRadius,
                  glassViews.first?.contentView === controller.host else {
                throw PanelTestFailure("\(name): expected exactly one glass view and no fallback material")
            }
        } else {
            guard materialViews.count == 1 else {
                throw PanelTestFailure("\(name): expected exactly one fallback material view")
            }
        }
        guard let hostLayer = controller.host.layer,
              hostLayer.backgroundColor == nil || hostLayer.backgroundColor?.alpha == 0,
              !controller.host.isOpaque,
              controller.host.safeAreaInsets.top == 0, controller.host.safeAreaInsets.bottom == 0,
              controller.host.safeAreaInsets.left == 0, controller.host.safeAreaInsets.right == 0,
              controller.host.safeAreaRegions == [],
              controller.host.sizingOptions == [.intrinsicContentSize] else {
            throw PanelTestFailure("\(name): hosting view has rectangular backing")
        }
        for scroll in views.compactMap({ $0 as? NSScrollView }) {
            guard !scroll.drawsBackground, !scroll.contentView.drawsBackground else {
                throw PanelTestFailure("\(name): scroll view paints a rectangular background")
            }
        }
        let material = controller.effectView
        guard abs(controller.host.frame.minY - material.bounds.minY) < 1,
              abs(controller.host.frame.height - material.bounds.height) < 1,
              abs(controller.host.frame.width - material.bounds.width) < 1 else {
            throw PanelTestFailure("\(name): hosting view does not fill the material content view")
        }
        let bitmap = try PanelCapture.bitmap(for: controller)
        let scale = CGFloat(bitmap.pixelsWide) / content.bounds.width
        let cornerSampleSize = Int(PanelChromeGeometry.cornerRadius * scale / 4)
        for left in [true, false] {
            for top in [true, false] {
                for dx in 0..<cornerSampleSize {
                    for dy in 0..<cornerSampleSize {
                        let x = left ? dx : bitmap.pixelsWide - 1 - dx
                        let y = top ? dy : bitmap.pixelsHigh - 1 - dy
                        guard let alpha = bitmap.colorAt(x: x, y: y)?.alphaComponent, alpha == 0 else {
                            throw PanelTestFailure("\(name): material outside rounded corner at (\(x), \(y))")
                        }
                    }
                }
            }
        }
        guard !panel.ignoresMouseEvents else { throw PanelTestFailure("\(name): panel ignores interior clicks") }
        if name == "dark appearance" {
            print("hierarchy: one effect view, clipped container, clear host/scroll backing, no child windows; corner alpha=0")
        }
        print("\(name): \(NSStringFromRect(frame)) fitting=\(expectedHeight)")
    }

    @MainActor private static func descendants(of view: NSView) -> [NSView] {
        [view] + view.subviews.flatMap { descendants(of: $0) }
    }
}

private struct PanelTestFailure: Error, CustomStringConvertible {
    let description: String
    init(_ description: String) { self.description = description }
}
