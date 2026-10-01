import AppKit
import Testing
@testable import DevsessBar

struct ClaudeBadgeTests {
    @Test @MainActor func hoverMakesArchivedCountReadableWithoutChangingBadgeSize() throws {
        let sessions = try #require(Fixtures.claudeSessions[Fixtures.twoServices.canonicalCwd])
        let resting = ClaudeSessionBadge(sessions: sessions)
        let hovered = ClaudeSessionBadge(sessions: sessions, previewHovered: true)
        #expect(resting.countColor == .tertiaryLabelColor)
        #expect(hovered.countColor == .secondaryLabelColor)
        #expect(resting.restingSize == hovered.restingSize)
        let live = [session("live", .live)]
        #expect(ClaudeSessionBadge(sessions: live).countColor == .secondaryLabelColor)
        #expect(ClaudeSessionBadge(sessions: live, previewHovered: true).countColor == .secondaryLabelColor)
    }

    private func session(_ id: String, _ state: ClaudeSessionState) -> ClaudeSession {
        ClaudeSession(id: id, title: id, state: state, modifiedAt: Date(timeIntervalSince1970: 0))
    }

    @Test func countsOnlyOpenSessionsInMixedBadges() {
        let state = ClaudeBadgeState(sessions: [session("archived", .archived), session("live", .live), session("open", .open)])
        #expect(state.count == 2)
        #expect(!state.archivedOnly)
        #expect(state.open.map(\.id) == ["live", "open"])
        #expect(state.archived.map(\.id) == ["archived"])
        #expect(state.directSession == nil)
    }

    @Test func onlySingleNonArchivedSessionsOpenDirectly() {
        for status in [ClaudeSessionState.live, .open] {
            #expect(ClaudeBadgeState(sessions: [session("single", status)]).directSession?.id == "single")
        }
        let archived = ClaudeBadgeState(sessions: [session("single", .archived)])
        #expect(archived.directSession == nil)
        #expect(archived.archivedOnly)
        #expect(archived.count == 1)
    }

    @Test func fixturesCoverSingleLiveMixedAndArchivedBadges() throws {
        let single = ClaudeBadgeState(sessions: try #require(Fixtures.claudeSessions[Fixtures.busy[0].canonicalCwd]))
        let mixed = ClaudeBadgeState(sessions: try #require(Fixtures.claudeSessions[Fixtures.busy[1].canonicalCwd]))
        let archived = ClaudeBadgeState(sessions: try #require(Fixtures.claudeSessions[Fixtures.busy[2].canonicalCwd]))
        #expect(single.directSession?.state == .live)
        #expect(single.count == 1)
        #expect(mixed.open.map(\.state) == [.open, .open])
        #expect(mixed.archived.count == 1)
        #expect(mixed.count == 2)
        #expect(archived.archivedOnly)
        #expect(archived.count == 4)
    }

    @Test @MainActor func mixedMenuGroupsArchivesAndMarksLiveSessions() {
        let state = ClaudeBadgeState(sessions: [session("archived", .archived), session("live", .live), session("open", .open)])
        let target = ClaudeSessionMenu.Coordinator(state: state)
        let menu = ClaudeSessionMenu.makeMenu(state: state, target: target)
        #expect(menu.items.map(\.title) == ["live", "open", "", "Archived", "archived"])
        #expect(menu.items[0].image != nil)
        #expect(menu.items[1].image == nil)
        #expect(menu.items[2].isSeparatorItem)
        #expect(!menu.items[3].isEnabled)
        #expect(menu.items[4].isEnabled)
        #expect(menu.items[4].representedObject as? URL == state.archived.first?.continuationURL)
        #expect(menu.items[4].attributedTitle?.attribute(.foregroundColor, at: 0, effectiveRange: nil) as? NSColor == .secondaryLabelColor)
    }

    @Test @MainActor func archivedOnlyMenuHasNoSeparator() {
        let state = ClaudeBadgeState(sessions: [session("old", .archived)])
        let target = ClaudeSessionMenu.Coordinator(state: state)
        let menu = ClaudeSessionMenu.makeMenu(state: state, target: target)
        #expect(menu.items.map(\.title) == ["Archived", "old"])
        #expect(!menu.items.contains { $0.isSeparatorItem })
        #expect(!menu.items[0].isEnabled)
        #expect(menu.items[1].isEnabled)
    }
}
