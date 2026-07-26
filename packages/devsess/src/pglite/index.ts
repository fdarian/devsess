import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { migrate } from 'drizzle-orm/pglite/migrator';
import { Data, Effect } from 'effect';
import { FileSystem } from 'effect/FileSystem';
import { Path } from 'effect/Path';
import type { DevSession } from '../dev-sessions';

export class PgliteError extends Data.TaggedError('PgliteError')<{
	message: string;
	cause?: unknown;
}> {}

const IN_MEMORY_DATA_DIR = 'memory://';

/** Drizzle's own defaults, used whenever a caller doesn't override them. */
const DEFAULT_MIGRATIONS_TABLE = '__drizzle_migrations';
const DEFAULT_MIGRATIONS_SCHEMA = 'drizzle';

export type PgliteMigrations = {
	migrationsFolder: string;
	migrationsTable?: string;
	migrationsSchema?: string;
};

/** Double-quotes an identifier part for safe interpolation into SQL. */
const quoteIdentifierPart = (part: string) => `"${part.replaceAll('"', '""')}"`;

const qualifiedMigrationsTable = (
	migrations: Pick<PgliteMigrations, 'migrationsTable' | 'migrationsSchema'>,
) =>
	`${quoteIdentifierPart(migrations.migrationsSchema ?? DEFAULT_MIGRATIONS_SCHEMA)}.${quoteIdentifierPart(migrations.migrationsTable ?? DEFAULT_MIGRATIONS_TABLE)}`;

/**
 * A persisted data dir that already exists holds a hydrated database, so it is
 * opened as-is rather than re-seeded from the dump. In-memory clients have
 * nothing to reuse.
 */
const shouldReuseExistingDatabase = (dataDir: string | undefined) =>
	Effect.gen(function* () {
		if (!dataDir || dataDir === IN_MEMORY_DATA_DIR) {
			return false;
		}
		const fs = yield* FileSystem;
		return yield* fs.exists(dataDir);
	});

export const createPgliteFromDump = (opts: {
	dataDir?: string;
	dumpPath: string;
}) =>
	Effect.gen(function* () {
		const fs = yield* FileSystem;

		if (yield* shouldReuseExistingDatabase(opts.dataDir)) {
			return new PGlite(opts.dataDir);
		}

		if (!(yield* fs.exists(opts.dumpPath))) {
			return yield* new PgliteError({
				message: `Dump file not found at ${opts.dumpPath}`,
			});
		}

		const buffer = yield* fs.readFile(opts.dumpPath);
		const file = new Blob([new Uint8Array(buffer)]);

		const client = new PGlite(opts.dataDir, {
			loadDataDir: file,
		});

		return client;
	});

const toUint8Array = (input: File | Blob) =>
	Effect.gen(function* () {
		const buf = yield* Effect.tryPromise({
			try: () => input.arrayBuffer(),
			catch: (error) =>
				new PgliteError({
					message: 'Failed to convert dump to Uint8Array',
					cause: error,
				}),
		});
		return new Uint8Array(buf);
	});

export const dumpPgliteToFile = (client: PGlite, dest: string) =>
	Effect.gen(function* () {
		const fs = yield* FileSystem;
		const path = yield* Path;

		const destDir = path.dirname(dest);
		const dirExists = yield* fs.exists(destDir);

		if (!dirExists) {
			yield* fs.makeDirectory(destDir, { recursive: true });
		}

		const dump = yield* Effect.tryPromise({
			try: () => client.dumpDataDir(),
			catch: (error) =>
				new PgliteError({
					message: 'Failed to dump PGlite database',
					cause: error,
				}),
		});

		const data = yield* toUint8Array(dump);
		yield* fs.writeFile(dest, data);
	});

export const migratePglite = (client: PGlite, migrations: PgliteMigrations) =>
	Effect.tryPromise({
		try: () =>
			migrate(drizzle(client), {
				migrationsFolder: migrations.migrationsFolder,
				migrationsTable: migrations.migrationsTable,
				migrationsSchema: migrations.migrationsSchema,
			}),
		catch: (error) =>
			new PgliteError({
				message: `Failed to migrate pglite from ${migrations.migrationsFolder}`,
				cause: error,
			}),
	});

const closePglite = (client: PGlite) =>
	Effect.tryPromise({
		try: () => client.close(),
		catch: (error) =>
			new PgliteError({
				message: 'Failed to close PGlite client',
				cause: error,
			}),
	});

export const getDbMigrationCount = (
	client: PGlite,
	migrations?: Pick<PgliteMigrations, 'migrationsTable' | 'migrationsSchema'>,
) =>
	Effect.gen(function* () {
		const qualifiedTable = qualifiedMigrationsTable(migrations ?? {});

		yield* Effect.tryPromise({
			try: () => client.waitReady,
			catch: (error) =>
				new PgliteError({
					message: 'Failed to wait for PGlite ready',
					cause: error,
				}),
		});

		const existsResult = yield* Effect.tryPromise({
			try: () =>
				client.query<{ exists: boolean }>(
					'SELECT to_regclass($1) IS NOT NULL AS "exists"',
					[qualifiedTable],
				),
			catch: (error) =>
				new PgliteError({
					message: 'Failed to check drizzle migrations table',
					cause: error,
				}),
		});

		const existsRow = existsResult.rows[0];
		if (!existsRow) {
			return yield* Effect.fail(
				new PgliteError({
					message: 'Missing row from drizzle migrations existence check',
				}),
			);
		}
		if (!existsRow.exists) {
			return 0;
		}

		const countResult = yield* Effect.tryPromise({
			try: () =>
				client.query<{ c: number }>(
					`SELECT count(*)::int AS c FROM ${qualifiedTable}`,
				),
			catch: (error) =>
				new PgliteError({
					message: 'Failed to count drizzle migrations',
					cause: error,
				}),
		});

		const countRow = countResult.rows[0];
		if (!countRow) {
			return yield* Effect.fail(
				new PgliteError({
					message: 'Missing row from drizzle migrations count query',
				}),
			);
		}
		return countRow.c;
	});

export const getExpectedMigrationCount = (migrationsFolder: string) =>
	Effect.gen(function* () {
		const fs = yield* FileSystem;
		const path = yield* Path;
		const journalPath = path.join(migrationsFolder, 'meta/_journal.json');
		const journalExists = yield* fs.exists(journalPath);
		if (!journalExists) {
			return yield* Effect.fail(
				new PgliteError({
					message: `Migration journal not found at ${journalPath}`,
				}),
			);
		}
		const content = yield* fs.readFileString(journalPath);
		const journal = yield* Effect.try({
			try: () => JSON.parse(content) as { entries: unknown[] },
			catch: (cause) =>
				new PgliteError({
					message: `Failed to parse migration journal at ${journalPath}`,
					cause,
				}),
		});
		if (!Array.isArray(journal.entries)) {
			return yield* Effect.fail(
				new PgliteError({
					message: `Migration journal at ${journalPath} is missing an "entries" array`,
				}),
			);
		}
		return journal.entries.length;
	});

export const buildPgliteDump = (
	opts: PgliteMigrations & { dumpPath: string },
) =>
	Effect.gen(function* () {
		const client = new PGlite(IN_MEMORY_DATA_DIR);
		yield* migratePglite(client, opts);
		yield* dumpPgliteToFile(client, opts.dumpPath);
		yield* closePglite(client);
	});

export const ensurePgliteDump = (
	opts: PgliteMigrations & { dumpPath: string },
) =>
	Effect.gen(function* () {
		const fs = yield* FileSystem;
		const dumpExists = yield* fs.exists(opts.dumpPath);
		if (!dumpExists) {
			yield* buildPgliteDump(opts);
		}
	});

export const openLitePglite = (
	opts: PgliteMigrations & { dataDir: string; dumpPath: string },
) =>
	Effect.gen(function* () {
		yield* ensurePgliteDump(opts);
		const client = yield* createPgliteFromDump({
			dataDir: opts.dataDir,
			dumpPath: opts.dumpPath,
		});
		const expected = yield* getExpectedMigrationCount(opts.migrationsFolder);
		const actual = yield* getDbMigrationCount(client, opts);
		/** Schema is present but nothing is journaled — it predates journaled migrations. */
		const predatesMigrationJournal = expected > 0 && actual === 0;
		if (predatesMigrationJournal) {
			return yield* Effect.fail(
				new PgliteError({
					message:
						`Stale local pglite at ${opts.dataDir} (schema present, no migration journal) — ` +
						'it was built by an older scheme. Remove it and the dump, then restart:\n' +
						`  rm -rf ${opts.dataDir} ${opts.dumpPath}`,
				}),
			);
		}
		yield* migratePglite(client, opts);
		return client;
	});

/**
 * Prepares a PGlite database scoped to a dev session: the data dir lives at
 * `<session>/pglite` and the migration dump at `<session>/pglite.dump`. Builds
 * the dump from `migrationsFolder` if missing, hydrates the client, and runs
 * pending migrations. Returns the open client plus the resolved paths so the
 * caller can pass them to the app (e.g. as `DATABASE_LITE_PATH`).
 */
export const prepareSessionPglite = (
	session: DevSession,
	opts: PgliteMigrations,
) =>
	Effect.gen(function* () {
		const dataDir = yield* session.path('pglite');
		const dumpPath = yield* session.path('pglite.dump');
		const client = yield* openLitePglite({
			...opts,
			dataDir,
			dumpPath,
		});
		return { client, dataDir, dumpPath };
	});
