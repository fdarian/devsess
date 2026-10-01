import Foundation

enum ServiceRowGeometry {
    static let height: CGFloat = 24
    static let horizontalInset: CGFloat = 9
    static let indicatorSize: CGFloat = 7
    static let spacing: CGFloat = 8
    static let stopZoneWidth = horizontalInset + indicatorSize + spacing

    static func shouldArm(at point: CGPoint, stopping: Bool, snapshotMode: Bool) -> Bool {
        !stopping && !snapshotMode
            && CGRect(x: 0, y: 0, width: stopZoneWidth, height: height).contains(point)
    }
}
