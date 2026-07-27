# devsess

Scaffold dev scripts with reusable **dev sessions** and a per-session **PGlite + Drizzle** adapter — built on [Effect](https://effect.website).

`devsess` gives your local `scripts/dev.ts` two things:

- **Dev sessions** — each run reuses (or creates) a named, slug-based working directory under `.data/sessions`. Sticky dev-server ports, managed subprocesses that die with your script, and cross-service "running" signal files come built in.
- **A PGlite adapter** (`devsess/pglite`) — prepare a local Postgres-compatible database from your Drizzle migrations, scoped to the current dev session. Perfect for a `--lite` offline dev mode.

It runs on **Node or Bun** — devsess depends on neither directly, you supply whichever platform package's layer you use (`NodeServices.layer`/`BunServices.layer`, or the equivalent `platform` object for `devsess/async`). The examples below use the [Effect](https://effect.website) API (`devsess`); if you'd rather not deal with Effect directly, `devsess/async` exposes the same dev-session scaffolding as a plain, Promise-based API — see [API](#api).

## Install

```bash
bun add devsess effect @effect/platform-node
# or, on Bun: bun add devsess effect @effect/platform-bun
```

For the PGlite adapter (`devsess/pglite`), also add:

```bash
bun add @electric-sql/pglite drizzle-orm
```

## Quickstart

```ts
// scripts/dev.ts
import { CurrentSession, DevSessions, getStickyPort, runManagedSubprocess } from 'devsess';
import { NodeRuntime, NodeServices } from '@effect/platform-node';
import { Effect } from 'effect';
import { Command, Flag } from 'effect/unstable/cli';

const web = Command.make(
	'web',
	{
		lite: Flag.boolean('lite').pipe(
			Flag.withDescription('Use a per-session PGlite database'),
		),
	},
	(opts) =>
		Effect.gen(function* () {
			const session = yield* CurrentSession;
			yield* Effect.logInfo(`[dev] session: ${session.name}`);

			const port = yield* getStickyPort(session);
			const env: Record<string, string> = { PORT: String(port) };

			if (opts.lite) {
				const litePath = yield* session.path('pglite');
				env.DATABASE_LITE = 'true';
				env.DATABASE_LITE_PATH = litePath;
			}

			yield* runManagedSubprocess('bunx', ['vite'], { env });
		}).pipe(Effect.provide(CurrentSession.layer)),
);

Command.run(web, { version: '0.1.0' }).pipe(
	Effect.provide(DevSessions.layer),
	Effect.provide(NodeServices.layer),
	Effect.scoped,
	NodeRuntime.runMain,
);
```

```bash
bun scripts/dev.ts --lite
```

`DevSessions.layer` auto-detects your project root (the nearest ancestor with a `package.json`) — no `dir` to pass. `CurrentSession.layer` sits on the handler, not around `Command.run`, so a `--help`/`--version` invocation never resolves (or creates) a session.

## Per-session PGlite

`prepareSessionPglite` builds a migration dump (if missing), hydrates a PGlite
client, validates and applies migrations — all scoped to the active dev session:

```ts
import { DevSessions, CurrentSession } from 'devsess';
import { prepareSessionPglite } from 'devsess/pglite';

// inside a handler, with CurrentSession.layer provided:
const sessions = yield* DevSessions;
const session = yield* CurrentSession;
const db = yield* prepareSessionPglite(session, {
	migrationsFolder: sessions.path('drizzle'),
});
// db.client — a ready PGlite client
// db.dataDir — its on-disk path (e.g. pass as DATABASE_LITE_PATH)
```

## API

From `devsess` (the Effect API):

- `DevSessions` — session-store service. `.layer` auto-detects the project root; `.layerAt(rootDir)` overrides it
- `CurrentSession` — resolved-session service for the current run. `.layer` resolves via `DevSessions`; `.layerOf(session)` pins one
- `ProjectRootNotFoundError` — raised by `DevSessions.layer` when no ancestor of `process.cwd()` has a `package.json`
- `getStickyPort(session)`, `runManagedSubprocess(cmd, args, opts?)`, `publishRunning(data)`, `awaitRunning(pkg)` — free functions; only `getStickyPort` takes a `DevSession`
- `SessionState.slot(schema)` — typed per-session JSON state

Build your CLI with a stock `Command.make(...)` from `effect/unstable/cli` — devsess no longer wraps it.

From `devsess/pglite`:

- `prepareSessionPglite(session, { migrationsFolder })`
- `openLitePglite({ dataDir, dumpPath, migrationsFolder })`
- `buildPgliteDump`, `ensurePgliteDump`, `migratePglite`,
  `dumpPgliteToFile`, `createPgliteFromDump`, `getDbMigrationCount`,
  `getExpectedMigrationCount`, and the `PgliteError` tagged error.

From `devsess/async` (a plain, Promise-based mirror of the Effect API — no `effect` imports required):

- `defineDevCli({ name, dir, platform, options?, run })` — `run` is `async (ctx, opts) => void`, and `ctx`'s helpers return Promises instead of Effects
- `createDevSessions(rootDir, services)` — async session manager (`getSessions`, `createSession`, `getLatestOrCreate`)
- `SessionState`, `DevSession`, plus `cli` and `Schema` re-exports

See the [full documentation](https://github.com/fdarian/devsess/tree/main/apps/docs) for details.

## License

Apache-2.0
