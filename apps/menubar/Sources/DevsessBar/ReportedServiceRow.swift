import AppKit
import SwiftUI

struct ReportedServiceRow: View {
    let child: ReportedService
    let state: ServiceState

    private var statusColor: Color {
        switch state {
        case .running: return Color(nsColor: .systemGreen)
        case .starting, .stopping: return Color(nsColor: .systemOrange)
        case .failed, .orphaned: return Color(nsColor: .systemRed)
        case .exited, .unknown: return Color(nsColor: .tertiaryLabelColor)
        }
    }

    var body: some View {
        HStack(spacing: ServiceRowGeometry.spacing) {
            Circle().fill(statusColor.opacity(0.7))
                .frame(width: ServiceRowGeometry.indicatorSize, height: ServiceRowGeometry.indicatorSize)
            Text(child.name)
                .lineLimit(1)
                .frame(maxWidth: .infinity, alignment: .leading)
            if let ports = child.ports {
                Text(ports.keys.sorted().compactMap { ports[$0] }.map { ":\($0)" }.joined(separator: " "))
                    .monospacedDigit()
                    .lineLimit(1)
            }
        }
        .font(.system(size: 12))
        .foregroundStyle(Color(nsColor: .secondaryLabelColor))
        .padding(.leading, ServiceRowGeometry.stopZoneWidth)
        .padding(.trailing, ServiceRowGeometry.horizontalInset)
        .frame(height: ServiceRowGeometry.height)
        .allowsHitTesting(false)
    }
}
