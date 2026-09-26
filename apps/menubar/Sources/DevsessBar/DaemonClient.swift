import Foundation
import Network

enum DaemonError: Error, LocalizedError {
    case unavailable, timedOut, frameTooLarge, invalidResponse, server(String)

    var errorDescription: String? {
        switch self {
        case .unavailable: "The devsess daemon isn't running."
        case .timedOut: "The daemon did not respond within 5 seconds."
        case .frameTooLarge: "The daemon response exceeds 1 MiB."
        case .invalidResponse: "The daemon returned an invalid response."
        case .server(let message): message
        }
    }
}

enum DaemonLocation {
    static func socketPath(environment: [String: String] = ProcessInfo.processInfo.environment, uid: uid_t = getuid()) -> String {
        if let runtime = environment["XDG_RUNTIME_DIR"] {
            return (runtime as NSString).appendingPathComponent("devsess/devsess.sock")
        }
        return "/tmp/devsess-\(uid)/devsess.sock"
    }

    static func logsPath(environment: [String: String] = ProcessInfo.processInfo.environment) -> String {
        if let state = environment["XDG_STATE_HOME"] {
            return (state as NSString).appendingPathComponent("devsess/logs")
        }
        return (NSHomeDirectory() as NSString).appendingPathComponent("Library/Logs/devsess")
    }
}

private struct Request<Params: Encodable>: Encodable {
    let version = 1
    let requestId: String
    let method: String
    let params: Params
}

private struct Response<Result: Decodable>: Decodable {
    let version: Int
    let requestId: String
    let ok: Bool
    let result: Result?
    let error: String?
}

private struct EmptyParams: Encodable {}
private struct StopParams: Encodable { let runId: String }
private struct RestartParams: Encodable { let runId: String; let serviceNames: [String] }
private struct EmptyResult: Decodable {}

final class DaemonClient: Sendable {
    let socketPath: String

    init(socketPath: String = DaemonLocation.socketPath()) { self.socketPath = socketPath }

    func listRuns() async throws -> [RunRecord] {
        try await call("listRuns", params: EmptyParams(), result: [RunRecord].self)
    }

    func stopRun(_ runId: String) async throws {
        _ = try await call("stopRun", params: StopParams(runId: runId), result: EmptyResult.self)
    }

    func restart(_ service: String, in runId: String) async throws {
        _ = try await call("restartServices", params: RestartParams(runId: runId, serviceNames: [service]), result: EmptyResult.self)
    }

    private func call<Params: Encodable, Result: Decodable>(
        _ method: String, params: Params, result: Result.Type
    ) async throws -> Result {
        let id = UUID().uuidString.lowercased()
        var payload = try JSONEncoder().encode(Request(requestId: id, method: method, params: params))
        payload.append(0x0A)
        let data = try await exchange(payload)
        let response = try JSONDecoder().decode(Response<Result>.self, from: data)
        guard response.version == 1, response.requestId == id else { throw DaemonError.invalidResponse }
        guard response.ok else {
            guard let error = response.error else { throw DaemonError.invalidResponse }
            throw DaemonError.server(error)
        }
        guard let value = response.result else { throw DaemonError.invalidResponse }
        return value
    }

    private func exchange(_ payload: Data) async throws -> Data {
        let connection = NWConnection(to: .unix(path: socketPath), using: .tcp)
        let session = SocketSession(connection: connection, payload: payload)
        return try await withTaskCancellationHandler {
            try await withCheckedThrowingContinuation { continuation in
                session.start(continuation)
            }
        } onCancel: {
            session.cancel()
        }
    }
}

private final class SocketSession: @unchecked Sendable {
    private let connection: NWConnection
    private let payload: Data
    private let queue = DispatchQueue(label: "devsess.socket")
    private var continuation: CheckedContinuation<Data, Error>?
    private var buffer = Data()
    private var timer: DispatchSourceTimer?
    private var completed = false

    init(connection: NWConnection, payload: Data) {
        self.connection = connection
        self.payload = payload
    }

    func start(_ continuation: CheckedContinuation<Data, Error>) {
        queue.async {
            self.continuation = continuation
            let timer = DispatchSource.makeTimerSource(queue: self.queue)
            timer.schedule(deadline: .now() + 5)
            timer.setEventHandler { self.finish(.failure(DaemonError.timedOut)) }
            self.timer = timer
            timer.resume()
            self.connection.stateUpdateHandler = { state in
                switch state {
                case .ready:
                    self.connection.send(content: self.payload, completion: .contentProcessed { error in
                        if let error { self.finish(.failure(error)) }
                        else { self.receive() }
                    })
                case .failed(let error): self.finish(.failure(error))
                case .cancelled: self.finish(.failure(CancellationError()))
                default: break
                }
            }
            self.connection.start(queue: self.queue)
        }
    }

    func cancel() { queue.async { self.finish(.failure(CancellationError())) } }

    private func receive() {
        connection.receive(minimumIncompleteLength: 1, maximumLength: 65536) { data, _, isComplete, error in
            if let error { self.finish(.failure(error)); return }
            if let data { self.buffer.append(data) }
            if let newline = self.buffer.firstIndex(of: 0x0A) {
                if newline > 1024 * 1024 { self.finish(.failure(DaemonError.frameTooLarge)); return }
                self.finish(.success(self.buffer.prefix(upTo: newline)))
            } else if self.buffer.count > 1024 * 1024 {
                self.finish(.failure(DaemonError.frameTooLarge))
            } else if isComplete {
                self.finish(.failure(DaemonError.invalidResponse))
            } else {
                self.receive()
            }
        }
    }

    private func finish(_ result: Result<Data, Error>) {
        guard !completed else { return }
        completed = true
        timer?.cancel()
        connection.cancel()
        continuation?.resume(with: result)
        continuation = nil
    }
}
