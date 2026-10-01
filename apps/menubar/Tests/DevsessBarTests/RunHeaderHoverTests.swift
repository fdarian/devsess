import Foundation
import Testing
@testable import DevsessBar

struct RunHeaderHoverTests {
    @Test func stopSlotIsLeftOfTheFixedBadgeFrame() {
        let size = CGSize(width: 33, height: 18)
        let badge = RunHeaderGeometry.badgeFrame(width: 290, badgeSize: size)
        let stop = RunHeaderGeometry.stopFrame(width: 290, badgeSize: size)
        #expect(badge == CGRect(x: 248, y: 1, width: 33, height: 18))
        #expect(stop == CGRect(x: 216, y: 0, width: 24, height: 20))
        #expect(stop.maxX + RunHeaderGeometry.badgeGap == badge.minX)
        #expect(!stop.intersects(badge))
        #expect(RunHeaderGeometry.shouldArm(at: CGPoint(x: 228, y: 10), width: 290,
            badgeSize: size, stopping: false, snapshotMode: false))
        #expect(!RunHeaderGeometry.shouldArm(at: CGPoint(x: 270, y: 10), width: 290,
            badgeSize: size, stopping: false, snapshotMode: false))
    }

    @Test func stopSlotUsesTrailingEdgeWithoutBadge() {
        let frame = RunHeaderGeometry.stopFrame(width: 290, badgeSize: nil)
        #expect(frame == CGRect(x: 264.5, y: 0, width: 24, height: 20))
        #expect(RunHeaderGeometry.shouldArm(at: CGPoint(x: 275, y: 10), width: 290,
            stopping: false, snapshotMode: false))
        #expect(!RunHeaderGeometry.shouldArm(at: CGPoint(x: 275, y: 10), width: 290,
            stopping: true, snapshotMode: false))
        #expect(!RunHeaderGeometry.shouldArm(at: CGPoint(x: 275, y: 10), width: 290,
            stopping: false, snapshotMode: true))
    }
}
