import AppKit
import QuartzCore

enum PanelChromeGeometry {
    static let cornerRadius: CGFloat = 12

    static func visiblePath(in bounds: CGRect) -> CGPath {
        CGPath(roundedRect: bounds, cornerWidth: cornerRadius, cornerHeight: cornerRadius, transform: nil)
    }
}

@MainActor final class PanelContainerView: NSView {
    override init(frame: NSRect) {
        super.init(frame: frame)
        wantsLayer = true
        guard let layer else { preconditionFailure("Missing panel container layer") }
        layer.backgroundColor = nil
        layer.cornerRadius = PanelChromeGeometry.cornerRadius
        layer.cornerCurve = .continuous
        // The glass view's outer backing layer remains rectangular; clip every descendant.
        layer.masksToBounds = true
    }

    required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }
}
