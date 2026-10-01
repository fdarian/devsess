import Foundation

struct ClaudeBadgeState {
    let sessions: [ClaudeSession]

    var open: [ClaudeSession] { sessions.filter { $0.state != .archived } }
    var archived: [ClaudeSession] { sessions.filter { $0.state == .archived } }
    var archivedOnly: Bool { open.isEmpty }
    var count: Int { archivedOnly ? archived.count : open.count }

    var directSession: ClaudeSession? {
        guard sessions.count == 1, let session = sessions.first, session.state != .archived else { return nil }
        return session
    }
}
