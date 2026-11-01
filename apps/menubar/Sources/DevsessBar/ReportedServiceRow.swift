import AppKit
import SwiftUI

struct ReportedServiceRow: View {
    let child: ReportedService
    let state: ServiceState

    var body: some View {
        HStack(spacing: ServiceRowGeometry.spacing) {
            Circle().fill(state.statusColor().opacity(0.7))
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
        .padding(.leading, ServiceRowGeometry.horizontalInset)
        .padding(.trailing, ServiceRowGeometry.horizontalInset)
        .frame(height: ServiceRowGeometry.height)
        .allowsHitTesting(false)
    }
}
