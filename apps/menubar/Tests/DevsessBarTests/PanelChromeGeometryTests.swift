import Foundation
import Testing
@testable import DevsessBar

struct PanelChromeGeometryTests {
    @Test func expandedWindowPreservesVisiblePanelAnchor() {
        let visible = CGRect(x: 200, y: 400, width: 300, height: 255)
        let window = PanelChromeGeometry.windowFrame(for: visible)
        let local = PanelChromeGeometry.visibleRect(in: CGRect(origin: .zero, size: window.size))
        #expect(local.offsetBy(dx: window.minX, dy: window.minY) == visible)
        #expect(window.minX < visible.minX)
        #expect(window.minY < visible.minY)
        #expect(window.maxY > visible.maxY)
    }

    @Test func roundedPanelExcludesMarginsAndCornerTips() {
        let bounds = CGRect(x: 0, y: 0, width: 380, height: 335)
        let visible = PanelChromeGeometry.visibleRect(in: bounds)
        let path = PanelChromeGeometry.visiblePath(in: bounds)
        #expect(path.contains(CGPoint(x: visible.midX, y: visible.midY)))
        for x in [visible.minX, visible.maxX] {
            for y in [visible.minY, visible.maxY] {
                #expect(!path.contains(CGPoint(x: x, y: y)))
            }
        }
        #expect(!path.contains(CGPoint(x: bounds.midX, y: 10)))
    }
}
