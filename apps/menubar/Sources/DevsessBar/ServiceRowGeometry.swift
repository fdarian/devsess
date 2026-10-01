import Foundation

enum ServiceRowGeometry {
    static let height: CGFloat = 24
    static let horizontalInset: CGFloat = 9
    static let indicatorSize: CGFloat = 7
    static let spacing: CGFloat = 8
    static let columnWidth: CGFloat = 48
    static let memoryTrailingGap: CGFloat = 4
    static let stopZoneWidth = horizontalInset + indicatorSize + spacing

    static var indicatorFrame: CGRect {
        CGRect(x: horizontalInset, y: (height - indicatorSize) / 2, width: indicatorSize, height: indicatorSize)
    }

    static var stopTintFrame: CGRect {
        StopSquareTintGeometry.frame(centeredOn: indicatorFrame)
    }

    static func shouldArm(at point: CGPoint, stopping: Bool, snapshotMode: Bool) -> Bool {
        !stopping && !snapshotMode
            && CGRect(x: 0, y: 0, width: stopZoneWidth, height: height).contains(point)
    }
}
