import AppKit

enum PanelSelfTest {
    @MainActor static func run() throws {
        let store = RunStore()
        store.runsForPreview(Fixtures.stress)
        let anchor = NSRect(x: -11500, y: -11100, width: 22, height: 22)
        let screen = NSRect(x: -12000, y: -12000, width: 1000, height: 1000)
        let controller = StatusItemController(store: store, showsStatusItem: false,
            testAnchor: anchor, testScreen: screen)
        defer { controller.panel.close() }

        try check("many runs", controller: controller, top: anchor.minY - 4)
        store.runsForPreview(Fixtures.busy)
        try check("few runs", controller: controller, top: anchor.minY - 4)
        store.runsForPreview([])
        try check("empty", controller: controller, top: anchor.minY - 4)
        store.runsForPreview(Fixtures.stress)
        try check("many runs restored", controller: controller, top: anchor.minY - 4)

        let smallScreen = NSRect(x: -12000, y: -11350, width: 1000, height: 350)
        let constrained = StatusItemController(store: store, showsStatusItem: false,
            testAnchor: anchor, testScreen: smallScreen)
        defer { constrained.panel.close() }
        try check("short screen", controller: constrained, top: anchor.minY - 4)
        guard constrained.panel.frame.height <= anchor.minY - 4 - smallScreen.minY else {
            throw PanelTestFailure("Panel extends below the screen")
        }
    }

    @MainActor private static func check(_ name: String, controller: StatusItemController, top: CGFloat) throws {
        for _ in 0..<4 {
            RunLoop.main.run(until: Date().addingTimeInterval(0.03))
            controller.updateLayout()
        }
        let panel = controller.panel
        guard let content = panel.contentView else { throw PanelTestFailure("Missing panel content") }
        let frame = panel.frame
        let expectedHeight = min(controller.host.intrinsicContentSize.height, controller.host.rootView.maximumHeight)
        guard abs(frame.maxY - top) < 1 else { throw PanelTestFailure("\(name): top moved to \(frame.maxY)") }
        guard abs(frame.height - expectedHeight) < 1 else {
            throw PanelTestFailure("\(name): height \(frame.height) differs from fitting \(expectedHeight)")
        }
        guard abs(frame.width - 300) < 1 else { throw PanelTestFailure("\(name): wrong panel width") }
        guard abs(controller.host.frame.minY - content.bounds.minY) < 1,
              abs(controller.host.frame.height - content.bounds.height) < 1,
              abs(controller.host.frame.width - content.bounds.width) < 1 else {
            throw PanelTestFailure("\(name): hosting view does not fill the material content view")
        }
        print("\(name): \(NSStringFromRect(frame)) fitting=\(expectedHeight)")
    }
}

private struct PanelTestFailure: Error, CustomStringConvertible {
    let description: String
    init(_ description: String) { self.description = description }
}
