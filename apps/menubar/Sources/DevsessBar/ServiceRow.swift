import AppKit
import SwiftUI

enum RowPreviewState {
    case normal, hovered, stopArmed
}

struct ServiceRow: View {
    let service: ServiceRecord
    let run: RunRecord
    let stopping: Bool
    var snapshotMode = false
    var previewState: RowPreviewState = .normal
    let stopArmed: Bool
    let setStopArmed: (Bool) -> Void
    let stop: () -> Void
    let restart: () -> Void
    var openURL: (URL) -> Void = { NSWorkspace.shared.open($0) }
    @LegacyState private var hovered = false

    private var armed: Bool { stopArmed }
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
        if let url = service.publishedURL {
            let host = url.host(percentEncoded: false) ?? url.absoluteString
            return url.port.map { "\(host):\($0)" } ?? host
        }
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

    private var indicator: some View {
        ZStack {
            if selected {
                RoundedRectangle(cornerRadius: 1.5)
                    .fill(armed ? Color(nsColor: .systemRed) : .white)
            } else {
                Circle().fill(statusColor)
            }
        }
        .frame(width: ServiceRowGeometry.indicatorSize, height: ServiceRowGeometry.indicatorSize)
        .allowsHitTesting(false)
    }

    private var urlLabel: some View {
        HStack(spacing: 4) {
            Text(armed ? "Stop \(service.name)" : service.name)
                .foregroundStyle(nameColor)
                .lineLimit(1)
            Spacer(minLength: 4)
            if let detail {
                Text(detail)
                    .foregroundStyle(detailColor)
                    .lineLimit(1)
                    .truncationMode(.middle)
                    .monospacedDigit()
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
            .help("Stop \(run.projectName)")
            .accessibilityLabel("Stop \(run.projectName)")
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
                setStopArmed(ServiceRowGeometry.shouldArm(at: location, stopping: stopping, snapshotMode: snapshotMode))
            case .ended:
                hovered = false
                setStopArmed(false)
            }
        }
        .onDisappear { setStopArmed(false) }
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
