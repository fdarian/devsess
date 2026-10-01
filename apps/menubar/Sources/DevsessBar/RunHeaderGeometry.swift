import Foundation

enum RunHeaderGeometry {
    static let height: CGFloat = 20
    static let stopZoneWidth: CGFloat = 24
    static let stopSquareSize: CGFloat = 9
    static let tintedBoxSize: CGFloat = 20
    static let trailingInset: CGFloat = 1.5

    static func shouldArm(at point: CGPoint, width: CGFloat, stopping: Bool, snapshotMode: Bool) -> Bool {
        !stopping && !snapshotMode && CGRect(x: width - trailingInset - stopZoneWidth,
            y: 0, width: stopZoneWidth, height: height).contains(point)
    }

    static func stopTitle(serviceCount: Int) -> String {
        "Stop \(serviceCount) \(serviceCount == 1 ? "server" : "servers")"
    }
}
