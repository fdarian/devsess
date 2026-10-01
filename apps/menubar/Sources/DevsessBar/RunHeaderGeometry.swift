import Foundation

enum RunHeaderGeometry {
    static let height: CGFloat = 20
    static let stopZoneWidth: CGFloat = 24
    static let stopSquareSize: CGFloat = 9
    static let tintedBoxSize: CGFloat = 20
    static let trailingInset: CGFloat = 1.5
    static let badgeTrailingInset: CGFloat = 9
    static let badgeGap: CGFloat = 8

    static func badgeFrame(width: CGFloat, badgeSize: CGSize) -> CGRect {
        CGRect(x: width - badgeTrailingInset - badgeSize.width, y: (height - badgeSize.height) / 2,
            width: badgeSize.width, height: badgeSize.height)
    }

    static func stopFrame(width: CGFloat, badgeSize: CGSize?) -> CGRect {
        let right: CGFloat
        if let badgeSize { right = badgeFrame(width: width, badgeSize: badgeSize).minX - badgeGap }
        else { right = width - trailingInset }
        return CGRect(x: right - stopZoneWidth, y: 0, width: stopZoneWidth, height: height)
    }

    static func shouldArm(at point: CGPoint, width: CGFloat, badgeSize: CGSize? = nil,
                          stopping: Bool, snapshotMode: Bool) -> Bool {
        !stopping && !snapshotMode && stopFrame(width: width, badgeSize: badgeSize).contains(point)
    }

    static func stopTitle(serviceCount: Int) -> String {
        "Stop \(serviceCount) \(serviceCount == 1 ? "server" : "servers")"
    }
}
