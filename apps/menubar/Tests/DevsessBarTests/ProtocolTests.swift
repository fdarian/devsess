import Foundation
import Testing
@testable import DevsessBar

struct ProtocolTests {
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
        #expect(Fixtures.busy[0].canonicalCwd == NSHomeDirectory() + "/code/nisi")
        #expect(Fixtures.busy[2].canonicalCwd == NSHomeDirectory() + "/.claude/worktrees/atlas/feat-auth")
        #expect(Fixtures.stress.count == 41)
        #expect(RunGroups(Fixtures.stress).active.count == 1)
        #expect(RunGroups(Fixtures.stress).finished.count == 40)
        #expect(Fixtures.stress[1].services[0].isFailure == false)
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

    @Test func stoppedServicesAreNotFailures() {
        let stopped = Fixtures.stress[1].services[0]
        #expect(stopped.state == .exited)
        #expect(stopped.signal == 15)
        #expect(!stopped.isFailure)

        let abnormal = ServiceRecord(
            name: "worker", command: "bun worker", cwd: "/tmp", state: .exited,
            exitCode: 2, signal: nil, published: nil
        )
        #expect(abnormal.isFailure)
        let cleanButMarkedFailed = ServiceRecord(
            name: "web", command: "bun dev", cwd: "/tmp", state: .failed,
            exitCode: 0, signal: nil, published: nil
        )
        #expect(!cleanButMarkedFailed.isFailure)
    }
}
