import AppKit
import Observation
import SwiftUI

@MainActor final class StatusItemController: NSObject, NSWindowDelegate {
    let panel: PanelWindow
    let host: SizingHostingView<PanelView>
    let container: PanelContainerView
    let effectView: NSView
    private let store: RunStore
    private var statusItem: NSStatusItem?
    private var globalMonitor: Any?
    private var localMonitor: Any?
    private var keyMonitor: Any?
    private var isHiding = false
    private let testAnchor: NSRect?
    private let testScreen: NSRect?

    init(store: RunStore, showsStatusItem: Bool = true, testAnchor: NSRect? = nil, testScreen: NSRect? = nil) {
        self.store = store
        self.testAnchor = testAnchor
        self.testScreen = testScreen
        host = SizingHostingView(rootView: PanelView(store: store))
        host.sizingOptions = [.intrinsicContentSize]
        host.safeAreaRegions = []
        host.wantsLayer = true
        host.layer?.backgroundColor = NSColor.clear.cgColor
        panel = PanelWindow(
            contentRect: NSRect(x: 0, y: 0, width: 300, height: 160),
            styleMask: [.borderless, .nonactivatingPanel],
            backing: .buffered, defer: false
        )
        let background: NSView
        if #available(macOS 26, *) {
            let glass = NSGlassEffectView(frame: NSRect(x: 0, y: 0, width: 300, height: 160))
            glass.style = .regular
            glass.cornerRadius = PanelChromeGeometry.cornerRadius
            glass.contentView = host
            background = glass
        } else {
            let material = NSVisualEffectView(frame: NSRect(x: 0, y: 0, width: 300, height: 160))
            material.material = .menu
            material.blendingMode = .behindWindow
            material.state = .active
            material.maskImage = Self.roundedMask(radius: PanelChromeGeometry.cornerRadius)
            host.frame = material.bounds
            host.autoresizingMask = [.width, .height]
            material.addSubview(host)
            background = material
        }
        effectView = background
        container = PanelContainerView(frame: background.frame)
        background.autoresizingMask = [.width, .height]
        container.addSubview(background)
        super.init()

        panel.isFloatingPanel = true
        panel.level = .floating
        panel.hasShadow = true
        panel.isOpaque = false
        panel.backgroundColor = .clear
        panel.isReleasedWhenClosed = false
        panel.becomesKeyOnlyIfNeeded = true
        panel.acceptsMouseMovedEvents = true
        panel.contentView = container
        panel.delegate = self
        panel.onDismiss = { [weak self] in self?.hide() }
        host.onSizeChange = { [weak self] in self?.updateLayout() }

        if showsStatusItem {
            let item = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
            statusItem = item
            item.button?.target = self
            item.button?.action = #selector(toggle)
            item.button?.imagePosition = .imageOnly
            updateIcon()
            store.start()
        }
        observeChanges()
    }

    @objc private func toggle() {
        if panel.isVisible { hide() }
        else { show() }
    }

    private func show() {
        store.panelOpen = true
        updateLayout()
        panel.makeKeyAndOrderFront(nil)
        panel.displayIfNeeded()
        panel.invalidateShadow()
        statusItem?.button?.highlight(true)
        installMonitors()
        Task { await store.refresh() }
    }

    func hide() {
        guard panel.isVisible, !isHiding else { return }
        isHiding = true
        store.panelOpen = false
        panel.orderOut(nil)
        statusItem?.button?.highlight(false)
        removeMonitors()
        isHiding = false
    }

    private func installMonitors() {
        globalMonitor = NSEvent.addGlobalMonitorForEvents(matching: [.leftMouseDown, .rightMouseDown]) { [weak self] _ in
            Task { @MainActor [weak self] in self?.hide() }
        }
        localMonitor = NSEvent.addLocalMonitorForEvents(matching: [.leftMouseDown, .rightMouseDown]) { [weak self] event in
            if let self {
                if event.window == self.panel {
                    let point = self.container.convert(event.locationInWindow, from: nil)
                    let shape = PanelChromeGeometry.visiblePath(in: self.container.bounds)
                    if !shape.contains(point) { self.hide() }
                } else if event.window != self.statusItem?.button?.window {
                    self.hide()
                }
            }
            return event
        }
        keyMonitor = NSEvent.addLocalMonitorForEvents(matching: .keyDown) { event in
            if event.modifierFlags.intersection(.deviceIndependentFlagsMask) == .command,
               event.charactersIgnoringModifiers?.lowercased() == "q" {
                NSApplication.shared.terminate(nil)
                return nil
            }
            return event
        }
    }

    func orderBackForCapture() {
        panel.orderBack(nil)
        panel.displayIfNeeded()
        panel.invalidateShadow()
    }

    func close() {
        removeMonitors()
        panel.orderOut(nil)
        panel.close()
    }

    private func removeMonitors() {
        if let globalMonitor { NSEvent.removeMonitor(globalMonitor); self.globalMonitor = nil }
        if let localMonitor { NSEvent.removeMonitor(localMonitor); self.localMonitor = nil }
        if let keyMonitor { NSEvent.removeMonitor(keyMonitor); self.keyMonitor = nil }
    }

    private func observeChanges() {
        withObservationTracking {
            _ = store.runs
            _ = store.daemonDown
            _ = store.statusError
            _ = store.actionErrors
            _ = store.stopping
            _ = store.stoppingServices
            _ = store.claudeByCwd
        } onChange: { [weak self] in
            Task { @MainActor [weak self] in
                guard let self else { return }
                self.observeChanges()
                self.updateIcon()
                self.host.invalidateIntrinsicContentSize()
                self.updateLayout()
            }
        }
    }

    private func updateIcon() {
        let count = store.groups.active.count
        statusItem?.button?.image = MenuBarIcon.image(idle: store.daemonDown || count == 0)
        if let displayedCount = MenuBarIcon.count(for: count, daemonDown: store.daemonDown) {
            statusItem?.button?.attributedTitle = NSAttributedString(string: "\(displayedCount)", attributes: [
                .font: NSFont.monospacedDigitSystemFont(ofSize: 12, weight: .medium)
            ])
            statusItem?.button?.imagePosition = .imageLeading
        } else {
            statusItem?.button?.title = ""
            statusItem?.button?.imagePosition = .imageOnly
        }
    }

    func updateLayout() {
        let anchor: NSRect
        let screen: NSRect
        if let testAnchor, let testScreen {
            anchor = testAnchor
            screen = testScreen
        } else {
            guard let button = statusItem?.button, let window = button.window,
                  let visibleFrame = window.screen?.visibleFrame else { return }
            anchor = window.convertToScreen(button.convert(button.bounds, to: nil))
            screen = visibleFrame
        }
        host.layoutSubtreeIfNeeded()
        let top = anchor.minY - 4
        let availableHeight = max(90, min(530, top - screen.minY))
        if abs(host.rootView.maximumHeight - availableHeight) > 0.5 {
            host.rootView.maximumHeight = availableHeight
            host.layoutSubtreeIfNeeded()
        }
        let fittingHeight = host.intrinsicContentSize.height
        guard fittingHeight > 0, fittingHeight.isFinite else { return }
        let height = min(fittingHeight, availableHeight)
        let width: CGFloat = 300
        let x = min(max(anchor.midX - width / 2, screen.minX), screen.maxX - width)
        let frame = NSRect(x: x, y: top - height, width: width, height: height)
        if abs(panel.frame.minX - frame.minX) > 0.5 || abs(panel.frame.minY - frame.minY) > 0.5
            || abs(panel.frame.width - frame.width) > 0.5 || abs(panel.frame.height - frame.height) > 0.5 {
            panel.setFrame(frame, display: panel.isVisible)
        }
        container.layoutSubtreeIfNeeded()
        if #available(macOS 26, *) {
            effectView.layoutSubtreeIfNeeded()
        } else {
            host.frame = effectView.bounds
        }
        panel.invalidateShadow()
    }

    var visiblePanelFrame: NSRect {
        panel.frame
    }

    func windowDidResize(_ notification: Notification) { panel.invalidateShadow() }

    private static func roundedMask(radius: CGFloat) -> NSImage {
        let side = radius * 2 + 1
        let mask = NSImage(size: NSSize(width: side, height: side), flipped: false) { rect in
            NSColor.white.setFill()
            NSBezierPath(roundedRect: rect, xRadius: radius, yRadius: radius).fill()
            return true
        }
        mask.capInsets = NSEdgeInsets(top: radius, left: radius, bottom: radius, right: radius)
        mask.resizingMode = .stretch
        return mask
    }
}

@MainActor final class SizingHostingView<Content: View>: NSHostingView<Content> {
    var onSizeChange: (() -> Void)?
    private var reportQueued = false

    override func acceptsFirstMouse(for event: NSEvent?) -> Bool { true }

    override func invalidateIntrinsicContentSize() {
        super.invalidateIntrinsicContentSize()
        queueReport()
    }

    override func layout() {
        super.layout()
        queueReport()
    }

    private func queueReport() {
        guard !reportQueued else { return }
        reportQueued = true
        Task { @MainActor [weak self] in
            await Task.yield()
            guard let self else { return }
            self.reportQueued = false
            self.onSizeChange?()
        }
    }
}
