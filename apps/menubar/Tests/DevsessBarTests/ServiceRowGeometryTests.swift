import Foundation
import Testing
@testable import DevsessBar

struct ServiceRowGeometryTests {
    @Test func stopZoneIncludesInsetIndicatorAndGapAtFullHeight() {
        #expect(ServiceRowGeometry.stopZoneWidth == 24)
        for x: CGFloat in [0, 8, 9, 12, 16, 23.99] {
            for y: CGFloat in [0, 12, 23.99] {
                #expect(ServiceRowGeometry.shouldArm(at: CGPoint(x: x, y: y), stopping: false, snapshotMode: false))
            }
        }
    }

    @Test func restOfRowAndOutsideNeverArm() {
        for point in [CGPoint(x: -1, y: 12), CGPoint(x: 24, y: 12), CGPoint(x: 100, y: 12),
                      CGPoint(x: 12, y: -1), CGPoint(x: 12, y: 24)] {
            #expect(!ServiceRowGeometry.shouldArm(at: point, stopping: false, snapshotMode: false))
        }
    }

    @Test func stoppingAndSnapshotsNeverArm() {
        let point = CGPoint(x: 12, y: 12)
        #expect(!ServiceRowGeometry.shouldArm(at: point, stopping: true, snapshotMode: false))
        #expect(!ServiceRowGeometry.shouldArm(at: point, stopping: false, snapshotMode: true))
    }
}
