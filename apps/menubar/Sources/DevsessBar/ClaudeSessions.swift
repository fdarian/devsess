import Darwin
import Foundation

enum ClaudeSessionState: Int, Sendable, Comparable {
    case live, open, archived

    static func < (left: Self, right: Self) -> Bool { left.rawValue < right.rawValue }

    var label: String {
        switch self {
        case .live: "Live"
        case .open: "Open"
        case .archived: "Archived"
        }
    }
}

struct ClaudeSession: Identifiable, Sendable {
    let id: String
    let title: String
    let state: ClaudeSessionState
    let modifiedAt: Date

    var continuationURL: URL {
        var components = URLComponents()
        components.scheme = "claude"
        components.host = "code"
        components.path = "/continue"
        components.queryItems = [URLQueryItem(name: "session", value: id)]
        guard let url = components.url else { preconditionFailure("Invalid Claude session URL") }
        return url
    }
}

struct ClaudeDesktopDescriptor: Decodable, Sendable {
    let sessionId: String
    let cliSessionId: String?
    let cwd: String
    let title: String?
    let isArchived: Bool?
}

struct ClaudeCLIProcessDescriptor: Decodable, Sendable {
    let pid: Int32
    let sessionId: String
    let cwd: String
    let name: String?
}

enum ClaudeSessionIndex {
    static func match(
        desktop: [(descriptor: ClaudeDesktopDescriptor, modifiedAt: Date)],
        cli: [ClaudeCLIProcessDescriptor],
        isAlive: (Int32) -> Bool,
        cwds: Set<String>
    ) -> [String: [ClaudeSession]] {
        let liveIDs = Set(cli.filter { isAlive($0.pid) }.map(\.sessionId))
        var result: [String: [ClaudeSession]] = [:]
        for entry in desktop {
            let descriptor = entry.descriptor
            guard cwds.contains(descriptor.cwd), descriptor.sessionId.hasPrefix("local_") else { continue }
            let state: ClaudeSessionState
            if let cliID = descriptor.cliSessionId, liveIDs.contains(cliID) {
                state = .live
            } else if descriptor.isArchived == true {
                state = .archived
            } else {
                state = .open
            }
            let title = descriptor.title.flatMap { $0.isEmpty ? nil : $0 } ?? descriptor.sessionId
            let session = ClaudeSession(
                id: descriptor.sessionId,
                title: title,
                state: state,
                modifiedAt: entry.modifiedAt
            )
            result[descriptor.cwd, default: []].append(session)
        }
        for cwd in result.keys {
            result[cwd]?.sort {
                if $0.state != $1.state { return $0.state < $1.state }
                if $0.modifiedAt != $1.modifiedAt { return $0.modifiedAt > $1.modifiedAt }
                return $0.id < $1.id
            }
        }
        return result
    }
}

actor ClaudeSessionScanner {
    private struct Stamp: Equatable {
        let modifiedAt: Date
        let size: UInt64
    }

    private struct Cached<Value: Sendable>: Sendable {
        let stamp: Stamp
        let value: Value
    }

    private let desktopDirectory: URL
    private let cliDirectory: URL
    private let fileManager = FileManager()
    private let isAlive: @Sendable (Int32) -> Bool
    private var desktopCache: [String: Cached<ClaudeDesktopDescriptor>] = [:]
    private var cliCache: [String: Cached<ClaudeCLIProcessDescriptor>] = [:]
    private var lastRefresh: Date?
    private var lastResult: [String: [ClaudeSession]] = [:]

    init(home: URL = FileManager.default.homeDirectoryForCurrentUser,
         isAlive: @escaping @Sendable (Int32) -> Bool = { kill($0, 0) == 0 }) {
        desktopDirectory = home.appendingPathComponent("Library/Application Support/Claude/claude-code-sessions")
        cliDirectory = home.appendingPathComponent(".claude/sessions")
        self.isAlive = isAlive
    }

    func sessions(for cwds: Set<String>, now: Date = Date()) -> [String: [ClaudeSession]] {
        let eligible = Set(cwds.filter { $0.contains("/.claude/worktrees/") })
        guard !eligible.isEmpty else { return [:] }
        if let lastRefresh, now.timeIntervalSince(lastRefresh) < 5 {
            return lastResult.filter { eligible.contains($0.key) }
        }
        lastRefresh = now
        let desktopPaths = desktopFiles()
        let cliPaths = cliFiles()
        desktopCache = desktopCache.filter { desktopPaths.contains($0.key) }
        cliCache = cliCache.filter { cliPaths.contains($0.key) }

        for path in desktopPaths {
            guard let stamp = stamp(at: path) else { desktopCache.removeValue(forKey: path); continue }
            if desktopCache[path]?.stamp == stamp { continue }
            guard let value = decode(ClaudeDesktopDescriptor.self, at: path) else {
                desktopCache.removeValue(forKey: path)
                continue
            }
            desktopCache[path] = Cached(stamp: stamp, value: value)
        }
        for path in cliPaths {
            guard let stamp = stamp(at: path) else { cliCache.removeValue(forKey: path); continue }
            if cliCache[path]?.stamp == stamp { continue }
            guard let value = decode(ClaudeCLIProcessDescriptor.self, at: path),
                  let filePID = Int32(URL(fileURLWithPath: path).deletingPathExtension().lastPathComponent),
                  filePID == value.pid else {
                cliCache.removeValue(forKey: path)
                continue
            }
            cliCache[path] = Cached(stamp: stamp, value: value)
        }
        let desktop = desktopCache.values.map { (descriptor: $0.value, modifiedAt: $0.stamp.modifiedAt) }
        let cli = cliCache.values.map(\.value)
        lastResult = ClaudeSessionIndex.match(desktop: desktop, cli: cli, isAlive: isAlive, cwds: eligible)
        return lastResult
    }

    private func desktopFiles() -> Set<String> {
        var paths: Set<String> = []
        for account in directories(in: desktopDirectory) {
            for org in directories(in: account) {
                for name in entries(in: org) where name.hasPrefix("local_") && name.hasSuffix(".json") {
                    paths.insert(org.appendingPathComponent(name).path)
                }
            }
        }
        return paths
    }

    private func cliFiles() -> Set<String> {
        Set(entries(in: cliDirectory).filter {
            $0.hasSuffix(".json") && Int32(String($0.dropLast(5))) != nil
        }.map { cliDirectory.appendingPathComponent($0).path })
    }

    private func directories(in url: URL) -> [URL] {
        entries(in: url).compactMap { name in
            let child = url.appendingPathComponent(name)
            var isDirectory: ObjCBool = false
            return fileManager.fileExists(atPath: child.path, isDirectory: &isDirectory) && isDirectory.boolValue
                ? child : nil
        }
    }

    private func entries(in url: URL) -> [String] {
        guard let entries = try? fileManager.contentsOfDirectory(atPath: url.path) else { return [] }
        return entries
    }

    private func stamp(at path: String) -> Stamp? {
        guard let attributes = try? fileManager.attributesOfItem(atPath: path),
              let modifiedAt = attributes[.modificationDate] as? Date,
              let size = attributes[.size] as? NSNumber,
              attributes[.type] as? FileAttributeType == .typeRegular else { return nil }
        return Stamp(modifiedAt: modifiedAt, size: size.uint64Value)
    }

    private func decode<Value: Decodable>(_ type: Value.Type, at path: String) -> Value? {
        guard let data = try? Data(contentsOf: URL(fileURLWithPath: path)) else { return nil }
        return try? JSONDecoder().decode(type, from: data)
    }
}
