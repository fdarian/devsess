import SwiftUI
import Testing
@testable import DevsessBar

struct ClaudeMarkTests {
    @Test func vectorScalesIntoBadgeAndContainsItsCenter() {
        let rect = CGRect(x: 20, y: 30, width: 10, height: 10)
        let path = ClaudeMark().path(in: rect)
        #expect(rect.contains(path.boundingRect))
        #expect(path.contains(CGPoint(x: rect.midX, y: rect.midY)))
        #expect(!path.contains(CGPoint(x: rect.minX, y: rect.minY)))
        #expect(path.boundingRect.width > 9)
        #expect(path.boundingRect.height > 9)
    }
}
