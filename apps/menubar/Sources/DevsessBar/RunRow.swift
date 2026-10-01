import AppKit
import SwiftUI

struct RunRow: View {
    let run: RunRecord
    let stopping: Bool
    let error: String?
    let claudeSessions: [ClaudeSession]
    var snapshotMode = false
    var previewState: RowPreviewState = .normal
    let stop: () -> Void
    let stopService: (ServiceRecord) -> Void
    let isServiceStopping: (ServiceRecord) -> Bool
    let restart: (ServiceRecord) -> Void
    var openURL: (URL) -> Void = { NSWorkspace.shared.open($0) }
    @LegacyState private var headerHovered = false
    @LegacyState private var headerArmed = false

    private var headerSelected: Bool { headerHovered || runArmed || previewState == .headerHovered }
    private var runArmed: Bool { headerArmed || previewState == .headerArmed }

    private var header: some View {
        GeometryReader { geometry in
            HStack(spacing: 0) {
                Button {} label: {
                    Text(runArmed ? RunHeaderGeometry.stopTitle(serviceCount: run.services.count)
                        : "\(run.projectName) — \((run.canonicalCwd as NSString).lastPathComponent)")
                        .font(.system(size: 11, weight: .semibold))
                        .foregroundStyle(Color(nsColor: runArmed ? .systemRed : .secondaryLabelColor))
                        .lineLimit(1)
                        .truncationMode(.middle)
                        .padding(.leading, ServiceRowGeometry.horizontalInset)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .frame(height: RunHeaderGeometry.height)
                        .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                if !runArmed, !claudeSessions.isEmpty {
                    ClaudeSessionBadge(sessions: claudeSessions, snapshotMode: snapshotMode)
                        .padding(.leading, ServiceRowGeometry.spacing)
                        .padding(.trailing, headerSelected ? ServiceRowGeometry.spacing : 0)
                }
                if headerSelected {
                    Button(action: stop) {
                        RoundedRectangle(cornerRadius: 1)
                            .fill(Color(nsColor: runArmed ? .systemRed : .secondaryLabelColor))
                            .frame(width: RunHeaderGeometry.stopSquareSize, height: RunHeaderGeometry.stopSquareSize)
                            .allowsHitTesting(false)
                            .frame(width: RunHeaderGeometry.stopZoneWidth, height: RunHeaderGeometry.height)
                            .background {
                                RoundedRectangle(cornerRadius: 5)
                                    .fill(runArmed ? Color(nsColor: .systemRed).opacity(0.15) : .clear)
                                    .frame(width: RunHeaderGeometry.tintedBoxSize, height: RunHeaderGeometry.tintedBoxSize)
                                    .allowsHitTesting(false)
                            }
                            .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                    .disabled(stopping || snapshotMode)
                    .help("Stop all servers in \(run.projectName)")
                    .accessibilityLabel(RunHeaderGeometry.stopTitle(serviceCount: run.services.count))
                }
            }
            .padding(.trailing, headerSelected ? RunHeaderGeometry.trailingInset : ServiceRowGeometry.horizontalInset)
            .frame(height: RunHeaderGeometry.height)
            .background {
                RoundedRectangle(cornerRadius: 5)
                    .fill(headerSelected ? Color(nsColor: .quaternaryLabelColor) : .clear)
                    .allowsHitTesting(false)
            }
            .contentShape(Rectangle())
            .onContinuousHover { phase in
                switch phase {
                case .active(let point):
                    headerHovered = !snapshotMode
                    headerArmed = RunHeaderGeometry.shouldArm(at: point, width: geometry.size.width,
                        stopping: stopping, snapshotMode: snapshotMode)
                case .ended:
                    headerHovered = false
                    headerArmed = false
                }
            }
        }
        .frame(height: RunHeaderGeometry.height)
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            header
            ForEach(run.services.indices, id: \.self) { index in
                ServiceRow(service: run.services[index], run: run,
                    stopping: stopping || isServiceStopping(run.services[index]),
                    snapshotMode: snapshotMode,
                    previewState: index == 0 ? previewState : .normal,
                    headerHovered: headerSelected, headerArmed: runArmed,
                    stop: { stopService(run.services[index]) },
                    restart: { restart(run.services[index]) }, openURL: openURL)
            }
            if let error {
                Text(error)
                    .font(.system(size: 11))
                    .foregroundStyle(Color(nsColor: .systemRed))
                    .fixedSize(horizontal: false, vertical: true)
                    .padding(.horizontal, 9)
                    .padding(.vertical, 3)
            }
        }
    }
}
