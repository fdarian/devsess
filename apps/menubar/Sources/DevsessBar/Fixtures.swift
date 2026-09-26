import Foundation

enum Fixtures {
    static let busy: [RunRecord] = {
        let json = """
        [
          {"runId":"a","projectName":"nisi","presetName":"desktop","canonicalCwd":"/Users/preview/code/nisi","state":"running","services":[
            {"name":"desktop","command":"bun run scripts/dev.ts","cwd":"/Users/preview/code/nisi","state":"running","published":{"value":{"url":"http://localhost:50016/"}}}
          ]},
          {"runId":"b","projectName":"devsess","presetName":"docs","canonicalCwd":"/Users/preview/code/devsess","state":"starting","services":[
            {"name":"docs","command":"bun run docs --host 127.0.0.1","cwd":"/Users/preview/code/devsess","state":"starting"}
          ]},
          {"runId":"c","projectName":"atlas","presetName":"api","canonicalCwd":"/Users/preview/.worktrees/atlas/feat-auth","state":"running","services":[
            {"name":"api","command":"bun run src/server.ts --watch","cwd":"/Users/preview/.worktrees/atlas/feat-auth","state":"running","published":{"value":{"url":"http://localhost:3000/"}}},
            {"name":"worker","command":"bun run src/worker.ts --queue background","cwd":"/Users/preview/.worktrees/atlas/feat-auth","state":"failed","exitCode":1}
          ]},
          {"runId":"d","projectName":"old-site","presetName":"dev","canonicalCwd":"/Users/preview/code/old-site","state":"exited","services":[{"name":"web","command":"bun dev","cwd":"/Users/preview/code/old-site","state":"exited","exitCode":0}]},
          {"runId":"e","projectName":"nisi","presetName":"tests","canonicalCwd":"/Users/preview/code/nisi","state":"exited","services":[{"name":"test","command":"bun test --watch","cwd":"/Users/preview/code/nisi","state":"exited","exitCode":0}]}
        ]
        """
        return try! JSONDecoder().decode([RunRecord].self, from: Data(json.utf8))
    }()
}
