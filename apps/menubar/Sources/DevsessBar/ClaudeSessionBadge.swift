import AppKit
import SwiftUI

struct ClaudeSessionBadge: View {
    let sessions: [ClaudeSession]
    var snapshotMode = false

    private var tooltip: String {
        sessions.map { "\($0.title) — \($0.state.label)" }.joined(separator: "\n")
    }

    var body: some View {
        Group {
            if let session = sessions.first {
                if snapshotMode {
                    mark()
                } else if sessions.count == 1 {
                    Button { NSWorkspace.shared.open(session.continuationURL) } label: {
                        mark()
                    }
                    .buttonStyle(.plain)
                } else {
                    Menu {
                        ForEach(sessions) { candidate in
                            Button("\(candidate.title) — \(candidate.state.label)") {
                                NSWorkspace.shared.open(candidate.continuationURL)
                            }
                        }
                    } label: {
                        HStack(spacing: 2) {
                            mark()
                        }
                    }
                    .menuStyle(.borderlessButton)
                    .menuIndicator(.hidden)
                    .fixedSize(horizontal: true, vertical: true)
                }
            }
        }
        .help(tooltip)
        .accessibilityLabel(tooltip)
    }

    private func mark() -> some View {
        HStack(spacing: 3) {
            Sparkle().frame(width: 9, height: 9)
            Text("\(sessions.count)")
                .font(.system(size: 11, weight: .medium))
                .monospacedDigit()
        }
        .foregroundStyle(sessions.contains { $0.state == .live }
            ? Color(nsColor: .systemOrange) : Color(nsColor: .tertiaryLabelColor))
        .frame(height: 20)
    }
}

private struct Sparkle: Shape {
    func path(in rect: CGRect) -> Path {
        var path = Path()
        path.move(to: CGPoint(x: rect.midX, y: rect.minY))
        path.addCurve(to: CGPoint(x: rect.maxX, y: rect.midY),
                      control1: CGPoint(x: rect.midX + rect.width * 0.03, y: rect.minY + rect.height * 0.28),
                      control2: CGPoint(x: rect.maxX - rect.width * 0.28, y: rect.midY - rect.height * 0.03))
        path.addCurve(to: CGPoint(x: rect.midX, y: rect.maxY),
                      control1: CGPoint(x: rect.maxX - rect.width * 0.28, y: rect.midY + rect.height * 0.03),
                      control2: CGPoint(x: rect.midX + rect.width * 0.03, y: rect.maxY - rect.height * 0.28))
        path.addCurve(to: CGPoint(x: rect.minX, y: rect.midY),
                      control1: CGPoint(x: rect.midX - rect.width * 0.03, y: rect.maxY - rect.height * 0.28),
                      control2: CGPoint(x: rect.minX + rect.width * 0.28, y: rect.midY + rect.height * 0.03))
        path.addCurve(to: CGPoint(x: rect.midX, y: rect.minY),
                      control1: CGPoint(x: rect.minX + rect.width * 0.28, y: rect.midY - rect.height * 0.03),
                      control2: CGPoint(x: rect.midX - rect.width * 0.03, y: rect.minY + rect.height * 0.28))
        return path
    }
}
