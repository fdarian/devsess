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
