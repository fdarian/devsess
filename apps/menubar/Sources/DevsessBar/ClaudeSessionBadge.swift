import AppKit
import SwiftUI

struct ClaudeSessionBadge: View {
    let sessions: [ClaudeSession]
    var snapshotMode = false
    @LegacyState private var hovered = false

    private static let brandCoral = NSColor(srgbRed: 217.0 / 255, green: 119.0 / 255, blue: 87.0 / 255, alpha: 1)
    private var state: ClaudeBadgeState { ClaudeBadgeState(sessions: sessions) }

    private var tooltip: String {
        sessions.map { "\($0.title) — \($0.state.label)" }.joined(separator: "\n")
    }

    var body: some View {
        Group {
            if !sessions.isEmpty {
                if snapshotMode {
                    mark()
                } else if let session = state.directSession {
                    Button { NSWorkspace.shared.open(session.continuationURL) } label: {
                        mark()
                    }
                    .buttonStyle(.plain)
                } else {
                    ClaudeSessionMenu(state: state, image: badgeImage)
                        .frame(width: badgeImage.size.width + 12, height: 18)
                }
            }
        }
        .frame(height: 18)
        .background(hovered ? Color(nsColor: .quaternaryLabelColor) : .clear, in: Capsule())
        .contentShape(Capsule())
        .onHover { hovered = $0 && !snapshotMode }
        .help(tooltip)
        .accessibilityLabel(tooltip)
    }

    private var badgeImage: NSImage {
        let archivedOnly = state.archivedOnly
        let countColor: NSColor = archivedOnly ? .tertiaryLabelColor : .secondaryLabelColor
        let count = NSAttributedString(string: "\(state.count)", attributes: [
            .foregroundColor: countColor,
            .font: NSFont.monospacedDigitSystemFont(ofSize: 11, weight: .medium)
        ])
        let countSize = count.size()
        return NSImage(size: NSSize(width: 13 + countSize.width, height: 18), flipped: false) { rect in
            guard let context = NSGraphicsContext.current?.cgContext else { return false }
            context.saveGState()
            if archivedOnly {
                let configuration = NSImage.SymbolConfiguration(pointSize: 10, weight: .regular)
                    .applying(NSImage.SymbolConfiguration(paletteColors: [.tertiaryLabelColor]))
                guard let archive = NSImage(systemSymbolName: "archivebox", accessibilityDescription: "Archived")?
                    .withSymbolConfiguration(configuration) else { preconditionFailure("Missing archivebox symbol") }
                archive.draw(in: NSRect(x: 0, y: (rect.height - 10) / 2, width: 10, height: 10))
            } else {
                Self.brandCoral.setFill()
                context.translateBy(x: 0, y: (rect.height + 10) / 2)
                context.scaleBy(x: 1, y: -1)
                context.addPath(ClaudeMark().path(in: CGRect(x: 0, y: 0, width: 10, height: 10)).cgPath)
                context.fillPath()
            }
            context.restoreGState()
            count.draw(at: NSPoint(x: 13, y: (rect.height - countSize.height) / 2))
            return true
        }
    }

    private func mark() -> some View {
        Image(nsImage: badgeImage)
            .renderingMode(.original)
            .padding(.horizontal, 6)
            .frame(height: 18)
            .contentShape(Capsule())
    }
}
