---
'devsess': minor
---

**Breaking.** The Effect API no longer wraps `effect/unstable/cli`. `devsess` exports services, layers, and free functions; you write a stock `Command.make(...)` yourself. `defineDevCli` and the `cli` re-export are gone from `devsess` — `devsess/async` keeps both.

**Install a platform package yourself.** `@effect/platform-node` is no longer a peer dependency. Add `@effect/platform-node` or `@effect/platform-bun` and provide its `NodeServices.layer` / `BunServices.layer`.

Before:

```ts
import { join } from 'node:path'
import { NodeRuntime, NodeServices } from '@effect/platform-node'
import { defineDevCli } from 'devsess'
import { Effect } from 'effect'

const main = defineDevCli({
	name: 'web',
	dir: join(import.meta.dirname, '..'),
	platform: { services: NodeServices.layer, runMain: NodeRuntime.runMain },
	run: (ctx) =>
		Effect.gen(function* () {
			const session = yield* ctx.session
			const port = yield* ctx.getStickyPort()
			yield* ctx.runManagedSubprocess('bunx', ['vite'], {
				env: { PORT: String(port) },
			})
		}),
})

main(process.argv)
```

After:

```ts
import { NodeRuntime, NodeServices } from '@effect/platform-node'
import { CurrentSession, DevSessions, getStickyPort, runManagedSubprocess } from 'devsess'
import { Effect } from 'effect'
import { Command } from 'effect/unstable/cli'

const web = Command.make('web', {}, () =>
	Effect.gen(function* () {
		const session = yield* CurrentSession
		const port = yield* getStickyPort(session)
		yield* runManagedSubprocess('bunx', ['vite'], {
			env: { PORT: String(port) },
		})
	}).pipe(Effect.provide(CurrentSession.layer)),
)

Command.run(web, { version: '0.1.0' }).pipe(
	Effect.provide(DevSessions.layer),
	Effect.provide(NodeServices.layer),
	Effect.scoped,
	NodeRuntime.runMain,
)
```

Migration notes:

- **`dir` is gone.** `DevSessions.layer` auto-detects the project root — the nearest ancestor of `process.cwd()` with a `package.json` — or fails with `ProjectRootNotFoundError`. Use `DevSessions.layerAt(rootDir)` to pass one explicitly.
- **Provide `CurrentSession.layer` around the handler, not around `Command.run`.** A layer's build effect runs the moment it's provided, so wrapping the whole CLI would create a session for `--help` and `--version` too.
- **The `ctx` members are free functions** on `devsess`: `getStickyPort`, `runManagedSubprocess`, `publishRunning`, `awaitRunning`. Only `getStickyPort` (and `prepareSessionPglite`) take a `DevSession`.
- **`Effect.scoped` is yours now.** It used to be internal to `defineDevCli`, and it's what lets managed subprocesses and running-signal files clean up on exit.
- **`--version` is real**, rather than the hardcoded `0.0.0` the old scaffolding reported.
- **`createDevSessions(rootDir, services)` takes a bare project root**, matching `DevSessions.layerAt`; both resolve to `<rootDir>/.data/sessions`. Stop pre-joining `.data/sessions` — passing the old path doubles it up and orphans existing sessions.
