import Foundation
import Testing
@testable import DevsessBar

struct StopServicesTests {
    private struct Request: Decodable {
        let version: Int
        let requestId: String
        let method: String
        let params: Params
    }
    private struct Params: Decodable {
        let runId: String
        let serviceNames: [String]
    }
    private struct Response: Encodable {
        let version = 1
        let requestId: String
        let ok: Bool
        let result: Empty?
        let error: String?
    }
    private struct Empty: Encodable {}

    @Test func sendsSelectedServiceNames() async throws {
        let client = DaemonClient(exchangeHandler: { payload in
            #expect(payload.last == 0x0A)
            let request = try JSONDecoder().decode(Request.self, from: payload)
            #expect(request.version == 1)
            #expect(request.method == "stopServices")
            #expect(request.params.runId == "run-a")
            #expect(request.params.serviceNames == ["api", "web"])
            return try JSONEncoder().encode(Response(requestId: request.requestId, ok: true, result: Empty(), error: nil))
        })
        try await client.stopServices(runId: "run-a", serviceNames: ["api", "web"])
    }

    @Test @MainActor func unsupportedMethodShowsInlineActionError() async throws {
        let run = Fixtures.twoServices
        let service = try #require(run.services.first)
        let client = DaemonClient(exchangeHandler: { payload in
            let request = try JSONDecoder().decode(Request.self, from: payload)
            #expect(request.method == "stopServices")
            #expect(request.params.runId == run.id)
            #expect(request.params.serviceNames == [service.name])
            return try JSONEncoder().encode(Response(requestId: request.requestId, ok: false,
                result: nil, error: "Unknown method: stopServices"))
        })
        let store = RunStore(client: client)
        store.runsForPreview([run])
        let task = store.stop(service, in: run)
        #expect(store.isStopping(service, in: run))
        #expect(!store.isStopping(run.services[1], in: run))
        await task.value
        #expect(store.actionErrors[run.id] == "Unknown method: stopServices")
        #expect(!store.isStopping(service, in: run))
        #expect(store.stopping.isEmpty)
        #expect(store.runs.map(\.id) == [run.id])
    }
}
