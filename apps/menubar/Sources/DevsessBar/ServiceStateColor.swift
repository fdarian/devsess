import AppKit
import SwiftUI

extension ServiceState {
    func statusColor(isFailure: Bool = false) -> Color {
        if isFailure { return Color(nsColor: .systemRed) }
        switch self {
        case .running: return Color(nsColor: .systemGreen)
        case .starting, .stopping: return Color(nsColor: .systemOrange)
        case .failed, .orphaned: return Color(nsColor: .systemRed)
        case .exited, .unknown: return Color(nsColor: .tertiaryLabelColor)
        }
    }
}
