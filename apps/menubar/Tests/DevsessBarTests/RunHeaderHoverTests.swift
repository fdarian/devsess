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

    @Test func tintIsCenteredOnSquareNotOnLeftExtendingHitZone() {
        let sizes: [CGSize?] = [nil, CGSize(width: 33, height: 18), CGSize(width: 47, height: 18)]
        for size in sizes {
            let square = RunHeaderGeometry.stopSquareFrame(width: 290, badgeSize: size)
            let tint = RunHeaderGeometry.stopTintFrame(width: 290, badgeSize: size)
            let hit = RunHeaderGeometry.stopFrame(width: 290, badgeSize: size)
            #expect(tint.size == CGSize(width: 20, height: 20))
            #expect(tint.midX == square.midX)
            #expect(tint.midY == square.midY)
            #expect(tint.midX != hit.midX)
            #expect(hit.maxX == square.maxX)
            #expect(tint.maxX - square.maxX == 5.5)
            if let size {
                let glyphLeft = RunHeaderGeometry.badgeFrame(width: 290, badgeSize: size).minX
                    + RunHeaderGeometry.badgeGlyphInset
                #expect(glyphLeft - tint.maxX == 2.5)
            }
        }
    }

    @Test func serviceTintUsesSameBoxCenteredWithoutChangingNameInset() {
        let square = ServiceRowGeometry.indicatorFrame
        let tint = ServiceRowGeometry.stopTintFrame
        #expect(tint.size == CGSize(width: 20, height: 20))
        #expect(StopSquareTintGeometry.cornerRadius == 5)
        #expect(tint.midX == square.midX)
        #expect(tint.midY == square.midY)
        #expect(tint == CGRect(x: 2.5, y: 2, width: 20, height: 20))
        #expect(ServiceRowGeometry.stopZoneWidth == 24)
        #expect(tint.maxX < ServiceRowGeometry.stopZoneWidth)
    }
}
