import Foundation
import Testing
@testable import DevsessBar

struct DaemonTimeoutTests {
    private struct Request: Decodable { let requestId: String }
    private struct Response: Encodable {
        let version = 1
        let requestId: String
        let ok = true
        let result: [String]
    }

    private final class Recorder: @unchecked Sendable {
        private let lock = NSLock()
        private var recorded: [TimeInterval] = []
        var timeouts: [TimeInterval] { lock.withLock { recorded } }
        func record(_ timeout: TimeInterval) { lock.withLock { recorded.append(timeout) } }
    }

    private func client(recording recorder: Recorder) -> DaemonClient {
        DaemonClient(exchangeHandler: { payload, timeout in
            recorder.record(timeout)
            let request = try JSONDecoder().decode(Request.self, from: payload)
            return try JSONEncoder().encode(Response(requestId: request.requestId, result: []))
        })
    }

    @Test func stopStaysAboveDaemonDeadline() {
        #expect(DaemonMethod.stopTimeout >= 10 + 1)
        #expect(DaemonMethod.readTimeout == 5)
    }

    @Test func readsUseShortTimeout() async throws {
        let recorder = Recorder()
        _ = try await client(recording: recorder).listRuns()
        #expect(recorder.timeouts == [DaemonMethod.readTimeout])
    }

    @Test func stopsAndRestartsUseLongTimeout() async throws {
        let recorder = Recorder()
        let daemon = client(recording: recorder)
        try await daemon.stopRun("run-a")
        try await daemon.stopServices(runId: "run-a", serviceNames: ["api"])
        try await daemon.restart("api", in: "run-a")
        #expect(recorder.timeouts == Array(repeating: DaemonMethod.stopTimeout, count: 3))
    }

    @Test func timeoutMessageNamesTheAppliedLimit() {
        #expect(DaemonError.timedOut(5).errorDescription == "The daemon did not respond within 5 seconds.")
        #expect(DaemonError.timedOut(15).errorDescription == "The daemon did not respond within 15 seconds.")
    }
}
