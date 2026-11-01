import AppKit

enum ServiceRowClickSelfTest {
    @MainActor static func run() throws {
        let run = Fixtures.twoServices
        guard let service = run.services.first,
              let expectedURL = service.publishedURL else { throw Failure("Missing URL fixture") }
        let store = RunStore()
        store.runsForPreview([run])
        store.claudeSessionsForPreview(Fixtures.claudeSessions)
        let controller = StatusItemController(store: store, showsStatusItem: false,
            testAnchor: NSRect(x: -11500, y: -11100, width: 22, height: 22),
            testScreen: NSRect(x: -12000, y: -12000, width: 1000, height: 1000))
        defer { controller.close() }
        var opened: [URL] = []
        var stopped: [String] = []
        var stoppedServices: [ServiceStop] = []
        controller.host.rootView = PanelView(store: store,
            stopRun: { stopped.append($0.id) },
            stopService: { stoppedServices.append(ServiceStop(runId: $0.id, name: $1.name)) },
            openURL: { opened.append($0) })
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
        guard opened == [expectedURL], stopped.isEmpty, stoppedServices.isEmpty else {
            throw Failure("URL-area click did not exclusively open the URL")
        }
        try click(x: 17, controller: controller)
        let firstStop = ServiceStop(runId: run.id, name: service.name)
        guard opened == [expectedURL], stopped.isEmpty, stoppedServices == [firstStop] else {
            throw Failure("Service stop did not exclusively stop the clicked service")
        }
        try click(x: 17, fromTop: 5 + 20 + 24 + 12, controller: controller)
        let secondStop = ServiceStop(runId: run.id, name: run.services[1].name)
        guard stopped.isEmpty, stoppedServices == [firstStop, secondStop] else {
            throw Failure("Second service stop targeted the wrong service")
        }
        controller.host.rootView.previewState = .headerHovered
        controller.updateLayout()
        RunLoop.main.run(until: Date().addingTimeInterval(0.03))
        try click(x: 40, fromTop: 15, controller: controller)
        guard stopped.isEmpty else { throw Failure("Header text unexpectedly stops the run") }
        guard let sessions = Fixtures.claudeSessions[run.canonicalCwd] else { throw Failure("Missing badge fixture") }
        let badgeSize = ClaudeSessionBadge(sessions: sessions).restingSize
        let stopFrame = RunHeaderGeometry.stopFrame(width: 290, badgeSize: badgeSize)
        try click(x: 5 + stopFrame.midX, fromTop: 15, controller: controller)
        guard stopped == [run.id], stoppedServices == [firstStop, secondStop], opened == [expectedURL] else {
            throw Failure("Header stop did not exclusively stop the whole run")
        }
        controller.host.rootView.previewState = .normal
        guard let noURLRun = Fixtures.busy.first(where: { $0.services.first?.publishedURL == nil }) else {
            throw Failure("Missing no-URL fixture")
        }
        store.runsForPreview([noURLRun])
        for _ in 0..<4 {
            RunLoop.main.run(until: Date().addingTimeInterval(0.03))
            controller.updateLayout()
        }
        try click(x: 220, controller: controller)
        guard opened == [expectedURL], stopped == [run.id], stoppedServices == [firstStop, secondStop] else {
            throw Failure("Row without a URL did not ignore its URL-area click")
        }
        try click(x: 17, controller: controller)
        guard opened == [expectedURL], stopped == [run.id],
              stoppedServices == [firstStop, secondStop, ServiceStop(runId: noURLRun.id, name: noURLRun.services[0].name)] else {
            throw Failure("Row without a URL did not retain its stop action")
        }
        print("synthetic clicks: URLs, independent per-service stops, header whole-run stop, and no-URL rows passed")
    }

    @MainActor private static func click(x: CGFloat, fromTop: CGFloat = 5 + 20 + 12,
                                        controller: StatusItemController) throws {
        let host = controller.host
        let point = NSPoint(x: x, y: host.isFlipped ? fromTop : host.bounds.height - fromTop)
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

    private struct ServiceStop: Equatable {
        let runId: String
        let name: String
    }

    private struct Failure: Error, CustomStringConvertible {
        let description: String
        init(_ description: String) { self.description = description }
    }
}
