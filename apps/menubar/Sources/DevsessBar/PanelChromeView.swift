import AppKit
import QuartzCore

enum PanelChromeGeometry {
    static let cornerRadius: CGFloat = 12
    static let sideMargin: CGFloat = 40
    static let topMargin: CGFloat = 34
    static let bottomMargin: CGFloat = 46

    static func windowFrame(for visibleFrame: CGRect) -> CGRect {
        CGRect(x: visibleFrame.minX - sideMargin, y: visibleFrame.minY - bottomMargin,
            width: visibleFrame.width + sideMargin * 2,
            height: visibleFrame.height + topMargin + bottomMargin)
    }

    static func visibleRect(in bounds: CGRect) -> CGRect {
        CGRect(x: bounds.minX + sideMargin, y: bounds.minY + bottomMargin,
            width: max(0, bounds.width - sideMargin * 2),
            height: max(0, bounds.height - topMargin - bottomMargin))
    }

    static func visiblePath(in bounds: CGRect) -> CGPath {
        CGPath(roundedRect: visibleRect(in: bounds), cornerWidth: cornerRadius,
            cornerHeight: cornerRadius, transform: nil)
    }
}

@MainActor final class PanelChromeView: NSView {
    let shadowView = PanelShadowView()

    init(panelSize: NSSize) {
        let frame = PanelChromeGeometry.windowFrame(for: NSRect(origin: .zero, size: panelSize))
        super.init(frame: NSRect(origin: .zero, size: frame.size))
        wantsLayer = true
        addSubview(shadowView)
    }

    required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }

    var panelRect: CGRect { PanelChromeGeometry.visibleRect(in: bounds) }

    func containsPanelPoint(_ point: CGPoint) -> Bool {
        PanelChromeGeometry.visiblePath(in: bounds).contains(point)
    }

    override func hitTest(_ point: NSPoint) -> NSView? { nil }

    override func layout() {
        super.layout()
        shadowView.frame = bounds
        shadowView.updateShadow(panelRect: panelRect)
    }
}

@MainActor final class PanelShadowView: NSView {
    private let caster = CAShapeLayer()
    private let cutout = CAShapeLayer()

    override init(frame: NSRect) {
        super.init(frame: frame)
        wantsLayer = true
        caster.fillColor = NSColor.black.cgColor
        caster.shadowColor = NSColor.black.cgColor
        caster.shadowRadius = 20
        caster.shadowOffset = CGSize(width: 0, height: -6)
        caster.shadowOpacity = 0.25
        cutout.fillRule = .evenOdd
        layer?.addSublayer(caster)
        layer?.mask = cutout
    }

    required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }

    override func hitTest(_ point: NSPoint) -> NSView? { nil }

    func updateShadow(panelRect: CGRect) {
        let shape = CGPath(roundedRect: panelRect, cornerWidth: PanelChromeGeometry.cornerRadius,
            cornerHeight: PanelChromeGeometry.cornerRadius, transform: nil)
        let outside = CGMutablePath()
        outside.addRect(bounds)
        outside.addPath(shape)
        CATransaction.begin()
        CATransaction.setDisableActions(true)
        caster.frame = bounds
        caster.path = shape
        caster.shadowPath = shape
        cutout.frame = bounds
        cutout.path = outside
        CATransaction.commit()
    }
}
