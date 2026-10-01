import Foundation

enum ServiceState: String, Decodable, Sendable {
    case starting, running, stopping, exited, failed, orphaned, unknown

    init(from decoder: Decoder) throws {
        let value = try decoder.singleValueContainer().decode(String.self)
        self = ServiceState(rawValue: value) ?? .unknown
    }
}

struct Published: Decodable, Sendable {
    let value: PublishedValue
}

struct PublishedValue: Decodable, Sendable {
    let url: String?

    init(from decoder: Decoder) throws {
        let container = try? decoder.container(keyedBy: CodingKeys.self)
        url = try container?.decodeIfPresent(String.self, forKey: .url)
    }

    private enum CodingKeys: String, CodingKey { case url }
}

struct ServiceRecord: Decodable, Sendable, Identifiable {
    let name: String
    let command: String
    let cwd: String
    let state: ServiceState
    let exitCode: Int?
    let signal: Int?
    let published: Published?
    let memoryBytes: Double?

    init(name: String, command: String, cwd: String, state: ServiceState, exitCode: Int?, signal: Int?,
         published: Published?, memoryBytes: Double? = nil) {
        self.name = name
        self.command = command
        self.cwd = cwd
        self.state = state
        self.exitCode = exitCode
        self.signal = signal
        self.published = published
        self.memoryBytes = memoryBytes
    }

    init(from decoder: Decoder) throws {
        let values = try decoder.container(keyedBy: CodingKeys.self)
        name = try values.decode(String.self, forKey: .name)
        command = try values.decode(String.self, forKey: .command)
        cwd = try values.decode(String.self, forKey: .cwd)
        state = try values.decode(ServiceState.self, forKey: .state)
        exitCode = try values.decodeIfPresent(Int.self, forKey: .exitCode)
        signal = try values.decodeIfPresent(Int.self, forKey: .signal)
        published = try values.decodeIfPresent(Published.self, forKey: .published)
        // Invalid optional telemetry must not hide an otherwise valid service.
        memoryBytes = try? values.decodeIfPresent(Double.self, forKey: .memoryBytes)
    }

    private enum CodingKeys: String, CodingKey {
        case name, command, cwd, state, exitCode, signal, published, memoryBytes
    }

    var id: String { name }
    var isFailure: Bool {
        if state == .orphaned { return true }
        if (state == .exited || state == .failed) && (exitCode == 0 || signal == 15) { return false }
        return state == .failed || (state == .exited && exitCode.map { $0 != 0 } == true)
    }
    var publishedURL: URL? {
        guard let text = published?.value.url, let url = URL(string: text),
              url.scheme == "http" || url.scheme == "https" else { return nil }
        return url
    }
}

struct RunRecord: Decodable, Sendable, Identifiable {
    let runId: String
    let projectName: String
    let presetName: String
    let canonicalCwd: String
    let state: ServiceState
    let services: [ServiceRecord]

    var id: String { runId }
    var isActive: Bool {
        services.contains { [.starting, .running, .stopping, .orphaned].contains($0.state) }
    }
    var hasFailure: Bool {
        services.contains { $0.isFailure }
    }
    var glyphState: JackState {
        if hasFailure { return .failed }
        if services.contains(where: { $0.state == .starting || $0.state == .stopping }) { return .starting }
        return .ready
    }
}

enum JackState: Sendable { case ready, starting, failed }

struct RunGroups: Sendable {
    let active: [RunRecord]
    let finished: [RunRecord]

    init(_ runs: [RunRecord]) {
        active = runs.filter(\.isActive)
        finished = runs.filter { !$0.isActive }
    }
}
