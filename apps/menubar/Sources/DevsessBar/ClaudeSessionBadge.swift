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
                    mark(for: session)
                } else if sessions.count == 1 {
                    Button { NSWorkspace.shared.open(session.continuationURL) } label: {
                        mark(for: session)
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
                            mark(for: session)
                            Text("\(sessions.count)").font(.system(size: 9))
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

    private func mark(for session: ClaudeSession) -> some View {
        HStack(spacing: 3) {
            Image(systemName: "asterisk")
                .font(.system(size: 10, weight: .semibold))
                .overlay {
                    if session.state == .archived {
                        Circle().stroke(.secondary, lineWidth: 0.8).frame(width: 14, height: 14)
                    }
                }
            if session.state == .live {
                Circle().frame(width: 4, height: 4)
            }
        }
        .foregroundStyle(session.state == .archived
            ? Color.secondary : Color(red: 0.851, green: 0.467, blue: 0.341))
        .frame(height: 16)
    }
}
