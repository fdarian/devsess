import AppKit

enum ServiceRowClickSelfTest {
    @MainActor static func run() throws {
        guard let run = Fixtures.busy.first, let service = run.services.first,
              let expectedURL = service.publishedURL else { throw Failure("Missing URL fixture") }
        let store = RunStore()
        store.runsForPreview([run])
        let controller = StatusItemController(store: store, showsStatusItem: false,
            testAnchor: NSRect(x: -11500, y: -11100, width: 22, height: 22),
            testScreen: NSRect(x: -12000, y: -12000, width: 1000, height: 1000))
        defer { controller.close() }
        var opened: [URL] = []
        var stopped: [String] = []
        controller.host.rootView = PanelView(store: store,
            stopRun: { stopped.append($0.id) }, openURL: { opened.append($0) })
        controller.updateLayout()
        controller.orderBackForCapture()
        for _ in 0..<4 {
            RunLoop.main.run(until: Date().addingTimeInterval(0.03))
            controller.updateLayout()
        }
        guard controller.host.acceptsFirstMouse(for: nil), controller.panel.becomesKeyOnlyIfNeeded,
              !controller.panel.isKeyWindow,
              !controller.panel.ignoresMouseEvents, controller.panel.childWindows?.isEmpty != false else {
            throw Failure("First-click admission or window mouse routing is incorrect")
        }
        try click(x: 220, controller: controller)
        guard opened == [expectedURL], stopped.isEmpty else {
            throw Failure("URL-area click did not exclusively open the URL")
        }
        try click(x: 17, controller: controller)
        guard opened == [expectedURL], stopped == [run.id] else {
            throw Failure("Row clicks did not reach their independent actions")
        }
        guard let noURLRun = Fixtures.busy.first(where: { $0.services.first?.publishedURL == nil }) else {
            throw Failure("Missing no-URL fixture")
        }
        store.runsForPreview([noURLRun])
        for _ in 0..<4 {
            RunLoop.main.run(until: Date().addingTimeInterval(0.03))
            controller.updateLayout()
        }
        try click(x: 220, controller: controller)
        guard opened == [expectedURL], stopped == [run.id] else {
            throw Failure("Row without a URL did not ignore its URL-area click")
        }
        try click(x: 17, controller: controller)
        guard opened == [expectedURL], stopped == [run.id, noURLRun.id] else {
            throw Failure("Row without a URL did not retain its stop action")
        }
        print("service row: synthetic URL, stop, and no-URL clicks passed")
    }

    @MainActor private static func click(x: CGFloat, controller: StatusItemController) throws {
        let host = controller.host
        let rowCenterFromTop: CGFloat = 5 + 20 + ServiceRowGeometry.height / 2
        let point = NSPoint(x: x, y: host.isFlipped ? rowCenterFromTop : host.bounds.height - rowCenterFromTop)
        let location = host.convert(point, to: nil)
        for type: NSEvent.EventType in [.leftMouseDown, .leftMouseUp] {
            guard let event = NSEvent.mouseEvent(with: type, location: location, modifierFlags: [],
                timestamp: ProcessInfo.processInfo.systemUptime, windowNumber: controller.panel.windowNumber,
                context: nil, eventNumber: 1, clickCount: 1, pressure: type == .leftMouseDown ? 1 : 0) else {
                throw Failure("Could not construct synthetic mouse event")
            }
            guard controller.host.acceptsFirstMouse(for: event) else {
                throw Failure("Hosting view rejects the first mouse event")
            }
            controller.panel.sendEvent(event)
        }
        RunLoop.main.run(until: Date().addingTimeInterval(0.03))
    }

    private struct Failure: Error, CustomStringConvertible {
        let description: String
        init(_ description: String) { self.description = description }
    }
}
