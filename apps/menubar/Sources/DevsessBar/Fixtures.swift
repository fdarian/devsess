import Foundation

enum Fixtures {
    static let busy: [RunRecord] = {
        let home = NSHomeDirectory()
        let json = """
        [
          {"runId":"a","projectName":"nisi","presetName":"desktop","canonicalCwd":"\(home)/code/nisi","state":"running","services":[
            {"name":"desktop","command":"bun run scripts/dev.ts","cwd":"\(home)/code/nisi","state":"running","published":{"value":{"url":"http://localhost:50016/"}}}
          ]},
          {"runId":"b","projectName":"devsess","presetName":"docs","canonicalCwd":"\(home)/.claude/worktrees/devsess/docs-site","state":"starting","services":[
            {"name":"docs","command":"bun run docs --host 127.0.0.1","cwd":"\(home)/.claude/worktrees/devsess/docs-site","state":"starting"}
          ]},
          {"runId":"c","projectName":"atlas","presetName":"api","canonicalCwd":"\(home)/.claude/worktrees/atlas/feat-auth","state":"running","services":[
            {"name":"api","command":"bun run src/server.ts --watch","cwd":"\(home)/.claude/worktrees/atlas/feat-auth","state":"running","published":{"value":{"url":"http://localhost:3000/"}}},
            {"name":"worker","command":"bun run src/worker.ts --queue background","cwd":"\(home)/.claude/worktrees/atlas/feat-auth","state":"failed","exitCode":1}
          ]},
          {"runId":"d","projectName":"old-site","presetName":"dev","canonicalCwd":"\(home)/code/old-site","state":"exited","services":[{"name":"web","command":"bun dev","cwd":"\(home)/code/old-site","state":"exited","exitCode":0}]},
          {"runId":"e","projectName":"nisi","presetName":"tests","canonicalCwd":"\(home)/code/nisi","state":"exited","services":[{"name":"test","command":"bun test --watch","cwd":"\(home)/code/nisi","state":"exited","exitCode":0}]}
        ]
        """
        return try! JSONDecoder().decode([RunRecord].self, from: Data(json.utf8))
    }()

    static let claudeSessions: [String: [ClaudeSession]] = {
        let modifiedAt = Date(timeIntervalSince1970: 1_790_000_000)
        return [
            busy[1].canonicalCwd: [ClaudeSession(id: "local_docs-live", title: "Polish docs navigation", state: .live, modifiedAt: modifiedAt)],
            busy[2].canonicalCwd: [ClaudeSession(id: "local_api-archived", title: "API worker investigation", state: .archived, modifiedAt: modifiedAt)]
        ]
    }()

    static let stress: [RunRecord] = {
        let finished = (0..<40).map { index in
            let cwd = "\(NSHomeDirectory())/.worktrees/mockingbird/refactor-engine-and-dashboard-\(index)-long-checkout"
            let service = ServiceRecord(
                name: index.isMultiple(of: 2) ? "engine" : "web",
                command: "cd $(pm cd @repo/engine --path) && bun run dev --sqlite --local hatchet --config ./config/development-\(index).json",
                cwd: cwd,
                state: index.isMultiple(of: 3) && index > 0 ? .failed : .exited,
                exitCode: index % 11 == 10 ? 1 : 0,
                signal: index.isMultiple(of: 2) ? 15 : nil,
                published: nil
            )
            return RunRecord(
                runId: "finished-\(index)", projectName: "mockingbird", presetName: "default",
                canonicalCwd: cwd, state: .exited, services: [service]
            )
        }
        guard let active = busy.first else { preconditionFailure("Missing active fixture") }
        return [active] + finished
    }()
}
