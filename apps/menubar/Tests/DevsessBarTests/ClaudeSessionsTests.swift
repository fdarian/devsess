import Foundation
import Testing
@testable import DevsessBar

struct ClaudeSessionsTests {
    @Test func decodesMissingOptionalFields() throws {
        let desktop = try JSONDecoder().decode(ClaudeDesktopDescriptor.self, from: Data(#"{"sessionId":"local_a","cwd":"/repo/.claude/worktrees/a"}"#.utf8))
        let cli = try JSONDecoder().decode(ClaudeCLIProcessDescriptor.self, from: Data(#"{"pid":123,"sessionId":"cli_a","cwd":"/repo/.claude/worktrees/a"}"#.utf8))
        #expect(desktop.title == nil)
        #expect(desktop.cliSessionId == nil)
        #expect(desktop.isArchived == nil)
        #expect(cli.name == nil)
    }

    @Test func matchesOrdersAndBuildsURL() throws {
        let cwd = "/repo/.claude/worktrees/project/branch"
        let desktop = try [
            #"{"sessionId":"local_archived","cwd":"/repo/.claude/worktrees/project/branch","title":"Old","isArchived":true}"#,
            #"{"sessionId":"local_open-old","cwd":"/repo/.claude/worktrees/project/branch","title":"Draft","isArchived":false}"#,
            #"{"sessionId":"local_live","cliSessionId":"cli_live","cwd":"/repo/.claude/worktrees/project/branch","title":"Work","isArchived":false}"#,
            #"{"sessionId":"local_open-new","cwd":"/repo/.claude/worktrees/project/branch","title":"Latest","isArchived":false}"#,
            #"{"sessionId":"local_elsewhere","cwd":"/other/.claude/worktrees/a","isArchived":false}"#
        ].enumerated().map { index, json in
            (descriptor: try JSONDecoder().decode(ClaudeDesktopDescriptor.self, from: Data(json.utf8)), modifiedAt: Date(timeIntervalSince1970: Double(index)))
        }
        let cli = try JSONDecoder().decode(ClaudeCLIProcessDescriptor.self, from: Data(#"{"pid":123,"sessionId":"cli_live","cwd":"/repo/.claude/worktrees/project/branch"}"#.utf8))
        let result = ClaudeSessionIndex.match(desktop: desktop, cli: [cli], isAlive: { $0 == 123 }, cwds: [cwd])
        #expect(result[cwd]?.map(\.id) == ["local_live", "local_open-new", "local_open-old", "local_archived"])
        #expect(result[cwd]?.map(\.state) == [.live, .open, .open, .archived])
        #expect(result[cwd]?.first?.continuationURL.absoluteString == "claude://code/continue?session=local_live")
        let notLive = ClaudeSessionIndex.match(desktop: desktop, cli: [cli], isAlive: { _ in false }, cwds: [cwd])
        #expect(notLive[cwd]?.first?.id == "local_open-new")
    }

    @Test func scansChangesWithThrottleAndDropsDeletedFiles() async throws {
        let home = FileManager.default.temporaryDirectory.appendingPathComponent("devsess-claude-test-\(UUID().uuidString)")
        let desktopDir = home.appendingPathComponent("Library/Application Support/Claude/claude-code-sessions/account/org")
        let cliDir = home.appendingPathComponent(".claude/sessions")
        try FileManager.default.createDirectory(at: desktopDir, withIntermediateDirectories: true)
        try FileManager.default.createDirectory(at: cliDir, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: home) }
        let cwd = home.appendingPathComponent(".claude/worktrees/project/branch").path
        let desktop = desktopDir.appendingPathComponent("local_a.json")
        let cli = cliDir.appendingPathComponent("123.json")
        try Data("{\"sessionId\":\"local_a\",\"cliSessionId\":\"cli_a\",\"cwd\":\"\(cwd)\",\"title\":\"First\",\"isArchived\":false}".utf8).write(to: desktop)
        try Data("{\"pid\":123,\"sessionId\":\"cli_a\",\"cwd\":\"\(cwd)\"}".utf8).write(to: cli)
        let scanner = ClaudeSessionScanner(home: home, isAlive: { $0 == 123 })
        let start = Date(timeIntervalSince1970: 1_800_000_000)
        let initial = await scanner.sessions(for: [cwd], now: start)
        #expect(initial[cwd]?.first?.state == .live)
        try Data("{\"sessionId\":\"local_a\",\"cwd\":\"\(cwd)\",\"title\":\"Second title\",\"isArchived\":true}".utf8).write(to: desktop)
        let throttled = await scanner.sessions(for: [cwd], now: start.addingTimeInterval(2))
        #expect(throttled[cwd]?.first?.title == "First")
        let refreshed = await scanner.sessions(for: [cwd], now: start.addingTimeInterval(6))
        #expect(refreshed[cwd]?.first?.title == "Second title")
        #expect(refreshed[cwd]?.first?.state == .archived)
        try Data("{\"pid\":124,\"sessionId\":\"cli_a\",\"cwd\":\"\(cwd)\"}".utf8).write(to: cli)
        try Data("{\"sessionId\":\"local_a\",\"cliSessionId\":\"cli_a\",\"cwd\":\"\(cwd)\",\"title\":\"Open\",\"isArchived\":false}".utf8).write(to: desktop)
        let mismatchedPID = await scanner.sessions(for: [cwd], now: start.addingTimeInterval(12))
        #expect(mismatchedPID[cwd]?.first?.state == .open)
        try Data("{".utf8).write(to: desktop)
        let partial = await scanner.sessions(for: [cwd], now: start.addingTimeInterval(18))
        #expect(partial[cwd] == nil)
        try Data("{\"sessionId\":\"local_a\",\"cwd\":\"\(cwd)\",\"isArchived\":false}".utf8).write(to: desktop)
        let recovered = await scanner.sessions(for: [cwd], now: start.addingTimeInterval(24))
        #expect(recovered[cwd]?.first?.state == .open)
        try FileManager.default.removeItem(at: desktop)
        let deleted = await scanner.sessions(for: [cwd], now: start.addingTimeInterval(30))
        #expect(deleted[cwd] == nil)
    }
}
