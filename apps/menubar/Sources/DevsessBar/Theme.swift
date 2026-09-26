import SwiftUI

enum Theme {
    static let jade = Color(red: 0.247, green: 0.714, blue: 0.545)
    static let amber = Color(red: 0.91, green: 0.663, blue: 0.231)
    static let red = Color(red: 0.878, green: 0.322, blue: 0.294)

    static func lamp(_ state: ServiceState) -> Color {
        switch state {
        case .running: jade
        case .starting, .stopping: amber
        case .failed, .orphaned: red
        case .exited, .unknown: .secondary
        }
    }

    static func lamp(_ service: ServiceRecord) -> Color {
        if service.isFailure { return red }
        if service.state == .exited || service.state == .failed { return .secondary }
        return lamp(service.state)
    }
}
