import Foundation
import Testing
@testable import DevsessBar

struct ProtocolTests {
    @Test func reportedServicesFlattenInFirstAppearanceOrder() {
        let shared = ReportedService(name: "hatchet", ports: ["http": 63294, "grpc": 63295])
        let reordered = ReportedService(name: "hatchet", ports: ["grpc": 63295, "http": 63294])
        let distinct = ReportedService(name: "hatchet", ports: ["http": 63300])
        let postgres = ReportedService(name: "postgres", ports: ["postgres": 5432])
        let first = ServiceRecord(name: "engine", command: "run", cwd: "/tmp", state: .failed,
            exitCode: 1, signal: nil, published: nil, children: [shared, postgres])
        let second = ServiceRecord(name: "web", command: "run", cwd: "/tmp", state: .running,
            exitCode: nil, signal: nil, published: nil, children: [reordered, distinct])
        let run = RunRecord(runId: "flatten", projectName: "test", presetName: "dev",
            canonicalCwd: "/tmp", state: .running, services: [first, second])
        let reported = run.reportedServices
        #expect(reported.map(\.child.name) == ["hatchet", "postgres", "hatchet"])
        #expect(reported.map(\.state) == [.running, .failed, .running])
        #expect(reported[0].child.ports == shared.ports)
        #expect(reported[2].child.ports == distinct.ports)
        #expect(Set(reported.map(\.id)).count == 3)
        #expect(Fixtures.busy[2].reportedServices.count == 2)
    }

    @Test func reportedServicesRetainFirstNonRunningParentState() {
        let child = ReportedService(name: "shared", ports: nil)
        let services = [ServiceState.starting, .stopping, .failed].enumerated().map { entry in
            ServiceRecord(name: "parent-\(entry.offset)", command: "run", cwd: "/tmp",
                state: entry.element, exitCode: nil, signal: nil, published: nil, children: [child])
        }
        let run = RunRecord(runId: "states", projectName: "test", presetName: "dev",
            canonicalCwd: "/tmp", state: .starting, services: services)
        #expect(run.reportedServices.count == 1)
        #expect(run.reportedServices.first?.state == .starting)
        #expect(Fixtures.busy[1].reportedServices.isEmpty)
    }

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
        #expect(Fixtures.busy[0].canonicalCwd == NSHomeDirectory() + "/.claude/worktrees/nisi/desktop")
        #expect(Fixtures.busy[2].canonicalCwd == NSHomeDirectory() + "/.claude/worktrees/atlas/feat-auth")
        #expect(Fixtures.stress.count == 20)
        #expect(RunGroups(Fixtures.stress).active.count == 20)
        #expect(RunGroups(Fixtures.stress).finished.isEmpty)
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
        let stopped = ServiceRecord(name: "web", command: "bun dev", cwd: "/tmp", state: .exited,
                                    exitCode: 0, signal: 15, published: nil)
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

    @Test func menuBarCountThreshold() {
        #expect(MenuBarIcon.count(for: 0, daemonDown: false) == nil)
        #expect(MenuBarIcon.count(for: 1, daemonDown: false) == nil)
        #expect(MenuBarIcon.count(for: 2, daemonDown: false) == nil)
        #expect(MenuBarIcon.count(for: 3, daemonDown: false) == 3)
        #expect(MenuBarIcon.count(for: 12, daemonDown: false) == 12)
        #expect(MenuBarIcon.count(for: 12, daemonDown: true) == nil)
    }
}
