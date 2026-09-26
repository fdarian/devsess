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

    var id: String { name }
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
        services.contains { [.failed, .orphaned].contains($0.state) }
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
