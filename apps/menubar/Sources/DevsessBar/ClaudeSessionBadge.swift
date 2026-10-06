import AppKit
import SwiftUI

struct ClaudeSessionBadge: View {
    let sessions: [ClaudeSession]
    var snapshotMode = false
    var previewHovered = false
    var headerHighlighted = false
    var headerArmed = false
    @LegacyState private var pointerHovered = false
    private var hovered: Bool { pointerHovered || previewHovered }

    private static let brandCoral = NSColor(srgbRed: 217.0 / 255, green: 119.0 / 255, blue: 87.0 / 255, alpha: 1)
    private var state: ClaudeBadgeState { ClaudeBadgeState(sessions: sessions) }

    var restingSize: CGSize {
        CGSize(width: 13 + countText.size().width + RunHeaderGeometry.badgeGlyphInset * 2, height: 18)
    }

    var countColor: NSColor {
        headerArmed ? .systemRed : RunHeaderStyle.color
    }

    var countText: NSAttributedString {
        NSAttributedString(string: "\(state.count)", attributes: [
            .foregroundColor: countColor,
            .font: RunHeaderStyle.font
        ])
    }

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
                    mark().overlay {
                        ClaudeSessionMenu(state: state)
                    }
                }
            }
        }
        .frame(height: 18)
        .background(hovered ? Color.primary.opacity(0.08) : .clear, in: Capsule())
        .contentShape(Capsule())
        .onHover { pointerHovered = $0 && !snapshotMode }
        .help(tooltip)
        .accessibilityLabel(tooltip)
    }

    private func mark() -> some View {
        HStack(spacing: 3) {
            if state.archivedOnly {
                Image(systemName: "archivebox")
                    .font(.system(size: 10))
                    .foregroundStyle(Color(nsColor: countColor))
                    .frame(width: 10, height: 10)
            } else {
                ClaudeMark().fill(Color(nsColor: Self.brandCoral))
                    .frame(width: 10, height: 10)
            }
            Text("\(state.count)")
                .modifier(RunHeaderTextStyle(armed: headerArmed))
        }
            .padding(.horizontal, RunHeaderGeometry.badgeGlyphInset)
            .frame(height: 18)
            .contentShape(Capsule())
    }
}
