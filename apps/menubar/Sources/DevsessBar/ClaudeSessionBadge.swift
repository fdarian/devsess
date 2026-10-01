import AppKit
import SwiftUI

struct ClaudeSessionBadge: View {
    let sessions: [ClaudeSession]
    var snapshotMode = false
    @LegacyState private var hovered = false

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
        .frame(height: 18)
        .background(Color(nsColor: hovered ? .tertiaryLabelColor : .quaternaryLabelColor), in: Capsule())
        .contentShape(Capsule())
        .onHover { hovered = $0 && !snapshotMode }
        .help(tooltip)
        .accessibilityLabel(tooltip)
    }

    private var markColor: NSColor {
        sessions.contains { $0.state == .live } ? .systemOrange : .secondaryLabelColor
    }

    private var markImage: NSImage {
        let color = markColor
        // Native Menu labels bridge images and text, not arbitrary SwiftUI shapes.
        return NSImage(size: NSSize(width: 10, height: 10), flipped: false) { rect in
            guard let context = NSGraphicsContext.current?.cgContext else { return false }
            color.setFill()
            context.translateBy(x: 0, y: rect.height)
            context.scaleBy(x: 1, y: -1)
            context.addPath(ClaudeMark().path(in: rect).cgPath)
            context.fillPath()
            return true
        }
    }

    private func mark() -> some View {
        HStack(spacing: 3) {
            Image(nsImage: markImage)
                .renderingMode(.original)
                .frame(width: 10, height: 10)
            Text("\(sessions.count)")
                .font(.system(size: 11, weight: .medium))
                .monospacedDigit()
        }
        .foregroundStyle(Color(nsColor: markColor))
        .padding(.horizontal, 6)
        .frame(height: 18)
        .contentShape(Capsule())
    }
}
