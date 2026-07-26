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

export const createPgliteFromDump = (opts: {
	dataDir?: string;
	dumpPath: string;
}) =>
	Effect.gen(function* () {
		const fs = yield* FileSystem;

		if (opts.dataDir && opts.dataDir !== 'memory://') {
			const dirExists = yield* fs.exists(opts.dataDir);
			if (dirExists) {
				return new PGlite(opts.dataDir);
			}
		}

		const dumpExists = yield* fs.exists(opts.dumpPath);
		if (!dumpExists) {
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

export const migratePglite = (client: PGlite, migrationsFolder: string) =>
	Effect.tryPromise({
		try: () => migrate(drizzle(client), { migrationsFolder }),
		catch: (error) =>
			new PgliteError({
				message: `Failed to migrate pglite from ${migrationsFolder}`,
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

export const getDbMigrationCount = (client: PGlite) =>
	Effect.gen(function* () {
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
					'SELECT to_regclass(\'drizzle.__drizzle_migrations\') IS NOT NULL AS "exists"',
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
					'SELECT count(*)::int AS c FROM drizzle.__drizzle_migrations',
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
		const journal = JSON.parse(content) as { entries: unknown[] };
		return journal.entries.length;
	});

export const buildPgliteDump = (opts: {
	migrationsFolder: string;
	dumpPath: string;
}) =>
	Effect.gen(function* () {
		const client = new PGlite('memory://');
		yield* migratePglite(client, opts.migrationsFolder);
		yield* dumpPgliteToFile(client, opts.dumpPath);
		yield* closePglite(client);
	});

export const ensurePgliteDump = (opts: {
	migrationsFolder: string;
	dumpPath: string;
}) =>
	Effect.gen(function* () {
		const fs = yield* FileSystem;
		const dumpExists = yield* fs.exists(opts.dumpPath);
		if (!dumpExists) {
			yield* buildPgliteDump(opts);
		}
	});

export const openLitePglite = (opts: {
	dataDir: string;
	dumpPath: string;
	migrationsFolder: string;
}) =>
	Effect.gen(function* () {
		yield* ensurePgliteDump({
			migrationsFolder: opts.migrationsFolder,
			dumpPath: opts.dumpPath,
		});
		const client = yield* createPgliteFromDump({
			dataDir: opts.dataDir,
			dumpPath: opts.dumpPath,
		});
		const expected = yield* getExpectedMigrationCount(opts.migrationsFolder);
		const actual = yield* getDbMigrationCount(client);
		if (expected > 0 && actual === 0) {
			return yield* Effect.fail(
				new PgliteError({
					message:
						`Stale local pglite at ${opts.dataDir} (schema present, no migration journal) — ` +
						'it was built by an older scheme. Remove it and the dump, then restart:\n' +
						`  rm -rf ${opts.dataDir} ${opts.dumpPath}`,
				}),
			);
		}
		yield* migratePglite(client, opts.migrationsFolder);
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
	opts: { migrationsFolder: string },
) =>
	Effect.gen(function* () {
		const dataDir = yield* session.path('pglite');
		const dumpPath = yield* session.path('pglite.dump');
		const client = yield* openLitePglite({
			dataDir,
			dumpPath,
			migrationsFolder: opts.migrationsFolder,
		});
		return { client, dataDir, dumpPath };
	});
