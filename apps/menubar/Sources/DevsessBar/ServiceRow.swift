import AppKit
import SwiftUI

enum RowPreviewState {
    case normal, hovered, stopArmed, headerHovered, headerArmed
}

struct ServiceRow: View {
    let service: ServiceRecord
    let run: RunRecord
    let stopping: Bool
    var snapshotMode = false
    var previewState: RowPreviewState = .normal
    var headerHovered = false
    var headerArmed = false
    let stop: () -> Void
    let restart: () -> Void
    var openURL: (URL) -> Void = { NSWorkspace.shared.open($0) }
    @LegacyState private var hovered = false
    @LegacyState private var stopArmed = false

    private var armed: Bool { stopArmed || previewState == .stopArmed }
    private var selected: Bool { armed || hovered || previewState == .hovered }

    private var statusColor: Color {
        if service.isFailure || service.state == .failed || service.state == .orphaned {
            return Color(nsColor: .systemRed)
        }
        switch service.state {
        case .running: return Color(nsColor: .systemGreen)
        case .starting, .stopping: return Color(nsColor: .systemOrange)
        case .failed, .orphaned: return Color(nsColor: .systemRed)
        case .exited, .unknown: return Color(nsColor: .tertiaryLabelColor)
        }
    }

    private var detail: String? {
        if stopping { return "Stopping…" }
        if let url = service.publishedURL { return ServiceRowLabels.port(for: url) }
        if service.isFailure || service.state == .failed || service.state == .orphaned {
            if let code = service.exitCode { return "exit \(code)" }
            if let signal = service.signal { return "signal \(signal)" }
        }
        if service.state == .starting || service.state == .stopping { return "Starting…" }
        return nil
    }

    private var detailColor: Color {
        if armed { return Color(nsColor: .secondaryLabelColor) }
        if selected { return .white }
        if stopping { return Color(nsColor: .secondaryLabelColor) }
        if service.publishedURL != nil { return Color(nsColor: .linkColor) }
        if service.isFailure || service.state == .failed || service.state == .orphaned {
            return Color(nsColor: .systemRed)
        }
        return Color(nsColor: .secondaryLabelColor)
    }

    private var nameColor: Color {
        if armed { return Color(nsColor: .systemRed) }
        if selected { return .white }
        return Color(nsColor: .labelColor)
    }

    private var memoryLabel: String? {
        ServiceRowLabels.memory(for: service, stopping: stopping)
    }

    private var stopColor: Color {
        if armed || headerArmed { return Color(nsColor: .systemRed) }
        if headerHovered { return Color(nsColor: .secondaryLabelColor) }
        return .white
    }

    private var indicator: some View {
        ZStack {
            if selected || headerHovered || headerArmed {
                RoundedRectangle(cornerRadius: 1.5)
                    .fill(stopColor)
            } else {
                Circle().fill(statusColor)
            }
        }
        .frame(width: ServiceRowGeometry.indicatorSize, height: ServiceRowGeometry.indicatorSize)
        .allowsHitTesting(false)
    }

    private var urlLabel: some View {
        HStack(spacing: ServiceRowGeometry.spacing) {
            Text(armed ? "Stop \(service.name)" : service.name)
                .foregroundStyle(nameColor)
                .lineLimit(1)
                .frame(maxWidth: .infinity, alignment: .leading)
            if let memoryLabel {
                Text(memoryLabel)
                    .font(.system(size: 12))
                    .foregroundStyle(Color(nsColor: .secondaryLabelColor))
                    .monospacedDigit()
                    .lineLimit(1)
                    .frame(width: ServiceRowGeometry.columnWidth, alignment: .trailing)
                    .padding(.trailing, ServiceRowGeometry.memoryTrailingGap)
            }
            if let detail {
                Text(detail)
                    .foregroundStyle(detailColor)
                    .lineLimit(1)
                    .truncationMode(.middle)
                    .monospacedDigit()
                    .frame(width: service.publishedURL != nil && !stopping ? ServiceRowGeometry.columnWidth : nil,
                        alignment: .trailing)
            } else if memoryLabel != nil {
                Color.clear.frame(width: ServiceRowGeometry.columnWidth).allowsHitTesting(false)
            }
        }
        .padding(.trailing, ServiceRowGeometry.horizontalInset)
        .frame(maxWidth: .infinity, alignment: .leading)
        .frame(height: ServiceRowGeometry.height)
        .contentShape(Rectangle())
    }

    var body: some View {
        HStack(spacing: 0) {
            Button(action: stop) {
                indicator
                    .padding(.leading, ServiceRowGeometry.horizontalInset)
                    .padding(.trailing, ServiceRowGeometry.spacing)
                    .frame(width: ServiceRowGeometry.stopZoneWidth, height: ServiceRowGeometry.height)
                    .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .disabled(stopping || snapshotMode)
            .help("Stop \(service.name)")
            .accessibilityLabel("Stop \(service.name)")
            Button {
                if let url = service.publishedURL { openURL(url) }
            } label: {
                urlLabel
            }
            .buttonStyle(.plain)
            .disabled(snapshotMode)
            .accessibilityLabel("Open \(service.name)")
        }
        .font(.system(size: 13))
        .frame(height: ServiceRowGeometry.height)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background {
            RoundedRectangle(cornerRadius: 5)
                .fill(armed ? Color(nsColor: .quaternaryLabelColor)
                    : selected ? Color(nsColor: .selectedContentBackgroundColor) : .clear)
                .allowsHitTesting(false)
        }
        .contentShape(Rectangle())
        .onContinuousHover { phase in
            switch phase {
            case .active(let location):
                hovered = !snapshotMode
                stopArmed = ServiceRowGeometry.shouldArm(at: location, stopping: stopping, snapshotMode: snapshotMode)
            case .ended:
                hovered = false
                stopArmed = false
            }
        }
        .help("\(run.canonicalCwd)\n\(service.command)")
        .contextMenu {
            Button("Restart service", action: restart)
            Button("Copy URL") { copy(service.publishedURL?.absoluteString) }
                .disabled(service.publishedURL == nil)
            Button("Copy path") { copy(run.canonicalCwd) }
            Button("Reveal in Finder") {
                NSWorkspace.shared.activateFileViewerSelecting([URL(fileURLWithPath: run.canonicalCwd)])
            }
            Button("Open in Terminal") {
                let process = Process()
                process.executableURL = URL(fileURLWithPath: "/usr/bin/open")
                process.arguments = ["-a", "Terminal", run.canonicalCwd]
                do { try process.run() } catch { NSLog("Could not open Terminal: %@", error.localizedDescription) }
            }
            Button("Copy devsess tail \(run.runId)") { copy("devsess tail \(run.runId)") }
        }
    }

    private func copy(_ value: String?) {
        guard let value else { return }
        NSPasteboard.general.clearContents()
        NSPasteboard.general.setString(value, forType: .string)
    }
}
