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

    var body: some View {
        HStack(spacing: 8) {
            if selected {
                Button(action: stop) {
                    RoundedRectangle(cornerRadius: 1.5)
                        .fill(armed ? Color(nsColor: .systemRed) : .white)
                        .frame(width: 7, height: 7)
                        .frame(width: 14, height: 18)
                        .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .help("Stop \(run.projectName)")
                .disabled(stopping)
                .onHover { setStopArmed($0 && !snapshotMode && !stopping) }
                .frame(width: 7)
            } else {
                Circle()
                    .fill(statusColor)
                    .frame(width: 7, height: 7)
            }
            Text(armed ? "Stop \(service.name)" : service.name)
                .foregroundStyle(armed ? Color(nsColor: .systemRed) : selected ? .white : Color(nsColor: .labelColor))
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
        .font(.system(size: 13))
        .frame(height: 24)
        .padding(.horizontal, 9)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(armed ? Color(nsColor: .quaternaryLabelColor)
                    : selected ? Color(nsColor: .selectedContentBackgroundColor) : .clear,
                    in: RoundedRectangle(cornerRadius: 5))
        .background {
            Button {
                if let url = service.publishedURL { NSWorkspace.shared.open(url) }
            } label: {
                Color.clear.contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .disabled(service.publishedURL == nil)
        }
        .contentShape(Rectangle())
        .onHover {
            hovered = $0 && !snapshotMode
            if !$0 { setStopArmed(false) }
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
