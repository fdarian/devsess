import Foundation
import Testing
@testable import DevsessBar

@Test func decodeRealisticList() throws {
    let url = try #require(Bundle.module.url(forResource: "list-runs", withExtension: "json"))
    let runs = try JSONDecoder().decode([RunRecord].self, from: Data(contentsOf: url))
    #expect(runs.count == 3)
    #expect(runs[0].services[0].publishedURL?.absoluteString == "http://localhost:50016/")
    #expect(runs[1].services[1].exitCode == 1)
    let groups = RunGroups(runs)
    #expect(groups.active.count == 2)
    #expect(groups.finished.count == 1)
    #expect(groups.active.map(\.glyphState) == [.ready, .failed])
    #expect(Fixtures.busy.filter(\.isActive).map(\.glyphState) == [.ready, .starting, .failed])
}

@Test func unknownStatesAndJSONValues() throws {
    let data = Data(#"{"runId":"x","projectName":"x","presetName":"default","canonicalCwd":"/tmp/x","state":"future","services":[{"name":"x","cwd":"/tmp/x","command":"run","state":"future","published":{"value":[1,2,3]}}]}"#.utf8)
    let run = try JSONDecoder().decode(RunRecord.self, from: data)
    #expect(run.state == .unknown)
    #expect(run.services[0].state == .unknown)
    #expect(run.services[0].publishedURL == nil)
}

@Test func socketLocations() {
    #expect(DaemonLocation.socketPath(environment: [:], uid: 501) == "/tmp/devsess-501/devsess.sock")
    #expect(DaemonLocation.socketPath(environment: ["XDG_RUNTIME_DIR": "/run/user/501"], uid: 501) == "/run/user/501/devsess/devsess.sock")
    #expect(DaemonLocation.logsPath(environment: ["XDG_STATE_HOME": "/state"]) == "/state/devsess/logs")
}
