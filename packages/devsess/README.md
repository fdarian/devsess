# devsess

Scaffold dev scripts with reusable **dev sessions** and a per-session **PGlite + Drizzle** adapter — built on [Effect](https://effect.website).

`devsess` gives your local `scripts/dev.ts` two things:

- **Dev sessions** — each run reuses (or creates) a named, slug-based working directory under `.data/sessions`. Sticky dev-server ports, managed subprocesses that die with your script, and cross-service "running" signal files come built in.
- **A PGlite adapter** (`devsess/pglite`) — prepare a local Postgres-compatible database from your Drizzle migrations, scoped to the current dev session. Perfect for a `--lite` offline dev mode.

It targets **Node** (`@effect/platform-node`).

## Install

```bash
bun add devsess effect @effect/cli @effect/platform @effect/platform-node
```

For the PGlite adapter (`devsess/pglite`), also add:

```bash
bun add @electric-sql/pglite drizzle-orm
```

## Quickstart

```ts
// scripts/dev.ts
import { join } from 'node:path';
import { cli, defineDevCli } from 'devsess';
import { Effect } from 'effect';

const main = defineDevCli({
	name: 'web',
	dir: join(import.meta.dirname, '..'),
	options: {
		lite: cli.Options.boolean('lite').pipe(
			cli.Options.withDescription('Use a per-session PGlite database'),
		),
	},
	run: (ctx, opts) =>
		Effect.gen(function* () {
			const session = yield* ctx.session;
			yield* Effect.logInfo(`[dev] session: ${session.name}`);

			const port = yield* ctx.getStickyPort();
			const env: Record<string, string> = { PORT: String(port) };

			if (opts.lite) {
				const litePath = yield* session.path('pglite');
				env.DATABASE_LITE = 'true';
				env.DATABASE_LITE_PATH = litePath;
			}

			yield* ctx.runManagedSubprocess('bunx', ['vite'], { env });
		}),
});

main(process.argv);
```

```bash
bun scripts/dev.ts --lite
```

## Per-session PGlite

`prepareSessionPglite` builds a migration dump (if missing), hydrates a PGlite
client, validates and applies migrations — all scoped to the active dev session:

```ts
import { prepareSessionPglite } from 'devsess/pglite';

// inside run():
const session = yield* ctx.session;
const db = yield* prepareSessionPglite(session, {
	migrationsFolder: join(import.meta.dirname, '../drizzle'),
});
// db.client — a ready PGlite client
// db.dataDir — its on-disk path (e.g. pass as DATABASE_LITE_PATH)
```

## API

From `devsess`:

- `defineDevCli({ name, dir, options?, run })` → `(argv) => void`
- `cli` — re-export of `@effect/cli`
- `DevSessions`, `makeDevSessionsLayer(rootDir)`, `DevSession`
- `SessionState.slot(schema)` — typed per-session JSON state

From `devsess/pglite`:

- `prepareSessionPglite(session, { migrationsFolder })`
- `openLitePglite({ dataDir, dumpPath, migrationsFolder })`
- `buildPgliteDump`, `ensurePgliteDump`, `migratePglite`, `readSqlMigrations`,
  `dumpPgliteToFile`, `createPgliteFromDump`, `getDbMigrationCount`,
  `getExpectedMigrationCount`, and the `PgliteError` tagged error.

See the [full documentation](https://github.com/fdarian/devsess/tree/main/apps/docs) for details.

## License

Apache-2.0
