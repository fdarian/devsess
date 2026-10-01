import AppKit

@MainActor final class PanelWindow: NSPanel {
    var onDismiss: (() -> Void)?

    override var canBecomeKey: Bool { true }
    override var canBecomeMain: Bool { false }

    override func cancelOperation(_ sender: Any?) { onDismiss?() }
    override func resignKey() {
        super.resignKey()
        onDismiss?()
    }
}

@MainActor final class PanelShadowWindow: NSPanel {
    override var canBecomeKey: Bool { false }
    override var canBecomeMain: Bool { false }
}
