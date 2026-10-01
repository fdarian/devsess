import Foundation
import Testing
@testable import DevsessBar

struct RunHeaderHoverTests {
    @Test func stopSlotIsLeftOfTheFixedBadgeFrame() {
        let size = CGSize(width: 33, height: 18)
        let badge = RunHeaderGeometry.badgeFrame(width: 290, badgeSize: size)
        let stop = RunHeaderGeometry.stopFrame(width: 290, badgeSize: size)
        #expect(badge == CGRect(x: 248, y: 1, width: 33, height: 18))
        #expect(stop == CGRect(x: 222, y: 0, width: 24, height: 20))
        #expect(stop.maxX + RunHeaderGeometry.badgeGap == badge.minX + RunHeaderGeometry.badgeGlyphInset)
        #expect(!stop.intersects(badge))
        #expect(RunHeaderGeometry.shouldArm(at: CGPoint(x: 234, y: 10), width: 290,
            badgeSize: size, stopping: false, snapshotMode: false))
        #expect(!RunHeaderGeometry.shouldArm(at: CGPoint(x: 270, y: 10), width: 290,
            badgeSize: size, stopping: false, snapshotMode: false))
    }

    @Test func visibleSquareToBadgeGlyphGapIsEightPoints() {
        for badgeWidth: CGFloat in [33, 40, 47] {
            let size = CGSize(width: badgeWidth, height: 18)
            let badge = RunHeaderGeometry.badgeFrame(width: 290, badgeSize: size)
            let square = RunHeaderGeometry.stopSquareFrame(width: 290, badgeSize: size)
            let hit = RunHeaderGeometry.stopFrame(width: 290, badgeSize: size)
            #expect(badge.minX + RunHeaderGeometry.badgeGlyphInset - square.maxX == 8)
            #expect(hit.maxX == square.maxX)
            #expect(hit.minX < square.minX)
            #expect(hit.minY < square.minY && hit.maxY > square.maxY)
            #expect(!square.intersects(badge))
        }
    }

    @Test func stopSlotUsesTrailingEdgeWithoutBadge() {
        let frame = RunHeaderGeometry.stopFrame(width: 290, badgeSize: nil)
        #expect(frame == CGRect(x: 257, y: 0, width: 24, height: 20))
        let square = RunHeaderGeometry.stopSquareFrame(width: 290, badgeSize: nil)
        #expect(square == CGRect(x: 272, y: 5.5, width: 9, height: 9))
        #expect(frame.maxX == square.maxX)
        #expect(RunHeaderGeometry.shouldArm(at: CGPoint(x: 275, y: 10), width: 290,
            stopping: false, snapshotMode: false))
        #expect(!RunHeaderGeometry.shouldArm(at: CGPoint(x: 275, y: 10), width: 290,
            stopping: true, snapshotMode: false))
        #expect(!RunHeaderGeometry.shouldArm(at: CGPoint(x: 275, y: 10), width: 290,
            stopping: false, snapshotMode: true))
    }
}
