import Foundation
import Testing
@testable import DevsessBar

struct PanelChromeGeometryTests {
    @Test func roundedPanelExcludesCornerTips() {
        let bounds = CGRect(x: 0, y: 0, width: 300, height: 255)
        let path = PanelChromeGeometry.visiblePath(in: bounds)
        #expect(path.contains(CGPoint(x: bounds.midX, y: bounds.midY)))
        for x in [bounds.minX, bounds.maxX] {
            for y in [bounds.minY, bounds.maxY] {
                #expect(!path.contains(CGPoint(x: x, y: y)))
            }
        }
        #expect(!path.contains(CGPoint(x: bounds.midX, y: -1)))
        #expect(path.contains(CGPoint(x: bounds.midX, y: 1)))
    }
}
