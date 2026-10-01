import AppKit
import Network
import Observation
import SwiftUI

@MainActor @Observable final class RunStore {
    private(set) var runs: [RunRecord] = []
    private(set) var daemonDown = false
    private(set) var statusError: String?
    private(set) var actionErrors: [String: String] = [:]
    private(set) var stopping: Set<String> = []
    private(set) var stoppingServices: [String: Set<String>] = [:]
    private(set) var claudeByCwd: [String: [ClaudeSession]] = [:]
    var panelOpen = false
    private let client: DaemonClient
    private let claudeScanner: ClaudeSessionScanner
    private var polling: Task<Void, Never>?

    init(client: DaemonClient = DaemonClient(), claudeScanner: ClaudeSessionScanner = ClaudeSessionScanner()) {
        self.client = client
        self.claudeScanner = claudeScanner
    }

    var groups: RunGroups { RunGroups(runs) }

    func start() {
        guard polling == nil else { return }
        polling = Task { [weak self] in
            while let self, !Task.isCancelled {
                await self.refresh()
                try? await Task.sleep(for: .seconds(self.panelOpen ? 2 : 5))
            }
        }
    }

    func refresh() async {
        do {
            runs = try await client.listRuns()
            claudeByCwd = await claudeScanner.sessions(for: Set(runs.map(\.canonicalCwd)))
            daemonDown = false
            statusError = nil
            stopping = stopping.filter { id in runs.contains { $0.id == id && $0.state != .stopping } }
        } catch {
            runs = []
            claudeByCwd = [:]
            let nsError = error as NSError
            daemonDown = (nsError.domain == NSPOSIXErrorDomain && [2, 61].contains(nsError.code))
                || (error as? NWError).map { networkError in
                    if case .posix(let code) = networkError { return code == .ENOENT || code == .ECONNREFUSED }
                    return false
                } == true
            statusError = daemonDown ? nil : error.localizedDescription
        }
    }

    func stop(_ run: RunRecord) {
        stopping.insert(run.id)
        Task {
            do {
                try await client.stopRun(run.id)
                actionErrors.removeValue(forKey: run.id)
                await refresh()
            } catch {
                stopping.remove(run.id)
                actionErrors[run.id] = error.localizedDescription
            }
        }
    }

    func restart(_ service: ServiceRecord, in run: RunRecord) {
        Task {
            do {
                try await client.restart(service.name, in: run.id)
                actionErrors.removeValue(forKey: run.id)
                await refresh()
            } catch {
                actionErrors[run.id] = error.localizedDescription
            }
        }
    }

    func isStopping(_ service: ServiceRecord, in run: RunRecord) -> Bool {
        stopping.contains(run.id) || stoppingServices[run.id]?.contains(service.name) == true || service.state == .stopping
    }

    @discardableResult func stop(_ service: ServiceRecord, in run: RunRecord) -> Task<Void, Never> {
        stoppingServices[run.id, default: []].insert(service.name)
        return Task {
            defer {
                stoppingServices[run.id]?.remove(service.name)
                if stoppingServices[run.id]?.isEmpty == true { stoppingServices.removeValue(forKey: run.id) }
            }
            do {
                try await client.stopServices(runId: run.id, serviceNames: [service.name])
                actionErrors.removeValue(forKey: run.id)
                await refresh()
            } catch {
                actionErrors[run.id] = error.localizedDescription
            }
        }
    }

    func runsForPreview(_ value: [RunRecord]) { runs = value }
    func claudeSessionsForPreview(_ value: [String: [ClaudeSession]]) { claudeByCwd = value }
    func downForPreview() { daemonDown = true }
}
