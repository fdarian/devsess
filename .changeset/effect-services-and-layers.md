---
'devsess': minor
---

Breaking: the Effect API is no longer a config-object wrapper around `effect/unstable/cli` — `devsess` exports services, layers, and plain effects, and you write a stock `Command.make(...)` yourself. `defineDevCli` and the `cli` re-export are gone from `devsess` (they're unchanged in `devsess/async`, which still owns `main` on purpose for callers who don't want an `effect` import).

## `defineDevCli` → `Command.make`

Before:

```ts
// scripts/dev.ts
import { join } from 'node:path'
import { defineDevCli } from 'devsess'
import { NodeRuntime, NodeServices } from '@effect/platform-node'
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
// scripts/dev.ts
import { CurrentSession, DevSessions, getStickyPort, runManagedSubprocess } from 'devsess'
import { NodeRuntime, NodeServices } from '@effect/platform-node'
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

What changed and why:

- **No more `dir`.** `DevSessions.layer` auto-detects the project root — the nearest ancestor of `process.cwd()` containing a `package.json` — instead of you resolving it with `import.meta.dirname`. Pass an explicit root instead with `DevSessions.layerAt(rootDir)`. If no ancestor has a `package.json`, it fails with `ProjectRootNotFoundError` rather than silently falling back to `process.cwd()`.
- **`CurrentSession.layer` goes around the handler, not around `Command.run`.** It replaces `ctx.session` (same once-per-run caching), but a `Layer`'s build effect runs the moment it's provided — wrapping the whole CLI would resolve, and create, a session for `--help`/`--version`/a bad flag too. `Command.make`'s handler is the one place that's guaranteed not to run for those, so provide it there.
- **The `ctx` members are free functions now.** `getStickyPort`, `runManagedSubprocess`, `publishRunning`, `awaitRunning` all live on `devsess` directly. Only `getStickyPort` (and `prepareSessionPglite` from `devsess/pglite`) take a `DevSession` — `runManagedSubprocess`, `publishRunning`, and `awaitRunning` don't need one.
- **You own the scope.** `Effect.scoped(...)` used to be internal to `defineDevCli`; now it's yours to add around `Command.run(...)`. It's what gives managed subprocesses and running-signal files somewhere to register cleanup on exit or Ctrl-C.
- **`--version` is real now.** It used to be hardcoded to `0.0.0` in the CLI scaffolding; now it's whatever string you pass to `Command.run`/`Command.runWith`.

## `createDevSessions` takes a bare project root

`devsess/async`'s `createDevSessions(rootDir, services)` used to want the sessions directory itself. It now takes the project root, same convention as the Effect API's `DevSessions.layerAt` — both resolve sessions at `<rootDir>/.data/sessions`.

Before:

```ts
const sessions = createDevSessions(
	join(import.meta.dirname, '..', '.data/sessions'),
	NodeServices.layer,
)
```

After:

```ts
const sessions = createDevSessions(join(import.meta.dirname, '..'), NodeServices.layer)
```

Stop pre-joining `.data/sessions` yourself — passing the old pre-joined path as the new bare root would double it up (`.data/sessions/.data/sessions`) and orphan whatever sessions already exist on disk.
