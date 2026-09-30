import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from '@effect/vitest';
import { PGlite } from '@electric-sql/pglite';
import { readMigrationFiles } from 'drizzle-orm/migrator';
import { Effect } from 'effect';
import { DevSessions } from '../../src/dev-sessions';
import {
	buildPgliteDump,
	createPgliteFromDump,
	dumpPgliteToFile,
	ensurePgliteDump,
	getDbMigrationCount,
	getExpectedMigrationCount,
	migratePglite,
	openLitePglite,
	PgliteError,
	prepareSessionPglite,
} from '../../src/pglite';
import {
	makeTestDevSessionsLayer,
	sessionsStorageDir,
} from '../support/dev-sessions-layer';
import { writeMigrationsFixture } from '../support/migrations-fixture';
import { runTest } from '../support/run-test';
import { makeTempDir } from '../support/temp-dir';

const IN_MEMORY_DATA_DIR = 'memory://';

/**
 * `openLitePglite`/`prepareSessionPglite` hand back an open client with no
 * scope-based teardown -- the caller owns it and must close it explicitly.
 * Mirrors the private `closePglite` in src/pglite/index.ts, which isn't exported.
 */
const closeClient = (client: PGlite) =>
	Effect.tryPromise({
		try: () => client.close(),
		catch: (error) =>
			new PgliteError({
				message: 'Failed to close PGlite client',
				cause: error,
			}),
	});

describe('createPgliteFromDump', () => {
	it.effect('reuses an existing dataDir without reading the dump', () =>
		runTest(
			Effect.gen(function* () {
				const rootDir = yield* makeTempDir;
				const dataDir = join(rootDir, 'data');

				// Hydrate a real, standalone PGlite store at dataDir up front, matching
				// the "already has a database" branch createPgliteFromDump reuses.
				const seed = new PGlite(dataDir);
				yield* Effect.promise(() => seed.waitReady);
				yield* Effect.promise(() => seed.close());

				// A dump path that doesn't exist -- if it were ever read, this would
				// fail with "Dump file not found" instead of reusing dataDir.
				const dumpPath = join(rootDir, 'missing.dump');

				const client = yield* createPgliteFromDump({ dataDir, dumpPath });
				yield* Effect.promise(() => client.waitReady);
				yield* closeClient(client);
			}),
		),
	);

	it.effect(
		'fails with PgliteError when there is no usable dataDir and the dump is missing',
		() =>
			runTest(
				Effect.gen(function* () {
					const rootDir = yield* makeTempDir;
					const dumpPath = join(rootDir, 'missing.dump');

					const error = yield* createPgliteFromDump({ dumpPath }).pipe(
						Effect.flip,
					);

					expect(error).toBeInstanceOf(PgliteError);
					expect(error.message).toContain('Dump file not found');
				}),
			),
	);
});

describe('openLitePglite', () => {
	it.effect(
		'builds the dump, migrates, and opens a working client at memory://',
		() =>
			runTest(
				Effect.gen(function* () {
					const rootDir = yield* makeTempDir;
					const migrationsFolder = join(rootDir, 'migrations');
					yield* writeMigrationsFixture(migrationsFolder, { count: 2 });
					const dumpPath = join(rootDir, 'pglite.dump');

					const client = yield* openLitePglite({
						dataDir: IN_MEMORY_DATA_DIR,
						dumpPath,
						migrationsFolder,
					});

					const count = yield* getDbMigrationCount(client);
					expect(count).toBe(2);

					yield* closeClient(client);
				}),
			),
	);

	it.effect(
		'fails with a PgliteError carrying the rm -rf hint when the dump predates the migration journal',
		() =>
			runTest(
				Effect.gen(function* () {
					const rootDir = yield* makeTempDir;
					const migrationsFolder = join(rootDir, 'migrations');
					yield* writeMigrationsFixture(migrationsFolder, { count: 1 });
					const dumpPath = join(rootDir, 'pglite.dump');

					// Seed a dump whose schema was created outside drizzle's migrator, so it
					// has tables but no drizzle.__drizzle_migrations rows -- the "predates
					// journaled migrations" case the staleness guard exists for.
					const seed = new PGlite(IN_MEMORY_DATA_DIR);
					yield* Effect.promise(() => seed.waitReady);
					yield* Effect.promise(() =>
						seed.query('CREATE TABLE legacy (id serial primary key)'),
					);
					yield* dumpPgliteToFile(seed, dumpPath);
					yield* Effect.promise(() => seed.close());

					const error = yield* openLitePglite({
						dataDir: IN_MEMORY_DATA_DIR,
						dumpPath,
						migrationsFolder,
					}).pipe(Effect.flip);

					expect(error).toBeInstanceOf(PgliteError);
					expect(error.message).toContain(
						`rm -rf ${IN_MEMORY_DATA_DIR} ${dumpPath}`,
					);
				}),
			),
	);

	it.effect(
		'leaves the client open once its own scope closes -- caller owns teardown',
		() =>
			runTest(
				Effect.gen(function* () {
					const rootDir = yield* makeTempDir;
					const migrationsFolder = join(rootDir, 'migrations');
					yield* writeMigrationsFixture(migrationsFolder, { count: 1 });
					const dumpPath = join(rootDir, 'pglite.dump');

					const client = yield* Effect.scoped(
						openLitePglite({
							dataDir: IN_MEMORY_DATA_DIR,
							dumpPath,
							migrationsFolder,
						}),
					);

					// The scope wrapping openLitePglite above has already closed. If it ever
					// grows a finalizer that auto-closes the client, this query starts
					// failing -- that's the contract this test guards.
					const result = yield* Effect.promise(() =>
						client.query<{ one: number }>('SELECT 1 AS one'),
					);
					expect(result.rows).toEqual([{ one: 1 }]);

					yield* closeClient(client);
				}),
			),
	);
});

describe('ensurePgliteDump', () => {
	it.effect('builds the dump when absent and no-ops when already present', () =>
		runTest(
			Effect.gen(function* () {
				const rootDir = yield* makeTempDir;
				const migrationsFolder = join(rootDir, 'migrations');
				yield* writeMigrationsFixture(migrationsFolder, { count: 1 });
				const dumpPath = join(rootDir, 'pglite.dump');

				yield* ensurePgliteDump({ migrationsFolder, dumpPath });
				const built = yield* Effect.promise(() => readFile(dumpPath));
				expect(built.byteLength).toBeGreaterThan(0);

				// Replace the dump with a sentinel -- a rebuild would overwrite it with
				// real dump bytes, so its survival proves the second call no-opped.
				yield* Effect.promise(() => writeFile(dumpPath, 'sentinel'));

				yield* ensurePgliteDump({ migrationsFolder, dumpPath });
				const afterSecondCall = yield* Effect.promise(() =>
					readFile(dumpPath, 'utf8'),
				);
				expect(afterSecondCall).toBe('sentinel');
			}),
		),
	);
});

describe('migratePglite', () => {
	it.effect(
		'upgrades v0 bookkeeping by SQL hash without replaying applied migrations',
		() =>
			runTest(
				Effect.gen(function* () {
					const rootDir = yield* makeTempDir;
					const migrationsFolder = join(rootDir, 'migrations');
					yield* writeMigrationsFixture(migrationsFolder, { count: 1 });
					const localMigrations = yield* Effect.try(() =>
						readMigrationFiles({ migrationsFolder }),
					);
					const client = new PGlite(IN_MEMORY_DATA_DIR);
					yield* migratePglite(client, { migrationsFolder });
					yield* Effect.promise(() =>
						client.exec(`
					ALTER TABLE drizzle.__drizzle_migrations DROP COLUMN name, DROP COLUMN applied_at;
					UPDATE drizzle.__drizzle_migrations SET created_at = 1;
				`),
					);
					yield* writeMigrationsFixture(migrationsFolder, { count: 2 });
					yield* migratePglite(client, { migrationsFolder });
					yield* migratePglite(client, { migrationsFolder });
					expect(yield* getDbMigrationCount(client)).toBe(2);
					const rows = yield* Effect.promise(() =>
						client.query<{
							name: string;
							hash: string;
							applied_at: string | null;
						}>(
							'SELECT name, hash, applied_at FROM drizzle.__drizzle_migrations ORDER BY id',
						),
					);
					expect(rows.rows[0]).toEqual({
						name: localMigrations[0]?.name,
						hash: localMigrations[0]?.hash,
						applied_at: null,
					});
					yield* closeClient(client);
				}),
			),
	);

	it.effect(
		'applies migrations added to the folder after the dump was built',
		() =>
			runTest(
				Effect.gen(function* () {
					const rootDir = yield* makeTempDir;
					const migrationsFolder = join(rootDir, 'migrations');
					yield* writeMigrationsFixture(migrationsFolder, { count: 1 });
					const dumpPath = join(rootDir, 'pglite.dump');

					yield* buildPgliteDump({ migrationsFolder, dumpPath });

					// Extend the fixture after the dump was built -- migration 0000 is
					// rewritten with identical SQL, and 0001 is genuinely new.
					yield* writeMigrationsFixture(migrationsFolder, { count: 2 });

					const client = yield* createPgliteFromDump({
						dataDir: IN_MEMORY_DATA_DIR,
						dumpPath,
					});

					const newTableQuery = () =>
						client.query<{ exists: boolean }>(
							`SELECT to_regclass('"0001_migration"') IS NOT NULL AS "exists"`,
						);
					const before = yield* Effect.promise(newTableQuery);
					expect(before.rows[0]?.exists).toBe(false);

					yield* migratePglite(client, { migrationsFolder });

					const after = yield* Effect.promise(newTableQuery);
					expect(after.rows[0]?.exists).toBe(true);

					yield* closeClient(client);
				}),
			),
	);

	it.effect(
		'round-trips a custom migrationsTable/migrationsSchema, and reports 0 under the default lookup',
		() =>
			runTest(
				Effect.gen(function* () {
					const rootDir = yield* makeTempDir;
					const migrationsFolder = join(rootDir, 'migrations');
					yield* writeMigrationsFixture(migrationsFolder, { count: 2 });

					const client = new PGlite(IN_MEMORY_DATA_DIR);
					yield* Effect.promise(() => client.waitReady);

					const migrationsTable = 'custom_migrations';
					const migrationsSchema = 'custom_schema';

					yield* migratePglite(client, {
						migrationsFolder,
						migrationsTable,
						migrationsSchema,
					});

					const defaultCount = yield* getDbMigrationCount(client);
					expect(defaultCount).toBe(0);

					const overrideCount = yield* getDbMigrationCount(client, {
						migrationsTable,
						migrationsSchema,
					});
					expect(overrideCount).toBe(2);

					yield* closeClient(client);
				}),
			),
	);
});

describe('getExpectedMigrationCount', () => {
	it.effect('returns 0 for an empty migrations folder', () =>
		runTest(
			Effect.gen(function* () {
				const rootDir = yield* makeTempDir;

				expect(yield* getExpectedMigrationCount(rootDir)).toBe(0);
			}),
		),
	);

	it.effect('rejects a v0 journal with Drizzle’s upgrade guidance', () =>
		runTest(
			Effect.gen(function* () {
				const rootDir = yield* makeTempDir;
				yield* Effect.promise(() =>
					mkdir(join(rootDir, 'meta'), { recursive: true }),
				);
				yield* Effect.promise(() =>
					writeFile(join(rootDir, 'meta/_journal.json'), 'not json'),
				);

				const error = yield* getExpectedMigrationCount(rootDir).pipe(
					Effect.flip,
				);

				expect(error).toBeInstanceOf(PgliteError);
				expect(error.message).toContain(
					`Failed to read migrations from ${rootDir}`,
				);
				expect(String(error.cause)).toContain('drizzle-kit up');
			}),
		),
	);

	it.effect(
		'counts v1 migrations without a journal and ignores unrelated files',
		() =>
			runTest(
				Effect.gen(function* () {
					const rootDir = yield* makeTempDir;
					yield* writeMigrationsFixture(rootDir, { count: 3 });
					yield* Effect.promise(() =>
						writeFile(join(rootDir, 'README.md'), 'Not a migration'),
					);
					expect(yield* getExpectedMigrationCount(rootDir)).toBe(3);
				}),
			),
	);

	it.effect('wraps a missing migrations folder in PgliteError', () =>
		runTest(
			Effect.gen(function* () {
				const rootDir = yield* makeTempDir;
				const migrationsFolder = join(rootDir, 'missing');
				const error = yield* getExpectedMigrationCount(migrationsFolder).pipe(
					Effect.flip,
				);

				expect(error).toBeInstanceOf(PgliteError);
				expect(error.message).toContain(
					`Failed to read migrations from ${migrationsFolder}`,
				);
				expect(String(error.cause)).toContain('ENOENT');
			}),
		),
	);
});

describe('getDbMigrationCount', () => {
	it.effect('returns 0 when drizzle.__drizzle_migrations does not exist', () =>
		runTest(
			Effect.gen(function* () {
				const client = new PGlite(IN_MEMORY_DATA_DIR);
				yield* Effect.promise(() => client.waitReady);

				const count = yield* getDbMigrationCount(client);
				expect(count).toBe(0);

				yield* closeClient(client);
			}),
		),
	);
});

describe('prepareSessionPglite', () => {
	it.effect('resolves dataDir/dumpPath under the session directory', () =>
		runTest(
			Effect.gen(function* () {
				const rootDir = yield* makeTempDir;
				const migrationsFolder = join(rootDir, 'migrations');
				yield* writeMigrationsFixture(migrationsFolder, { count: 1 });

				const sessionsRoot = join(rootDir, 'sessions');
				const storageDir = sessionsStorageDir(sessionsRoot);
				const devSessions = yield* DevSessions.pipe(
					Effect.provide(makeTestDevSessionsLayer(sessionsRoot)),
				);
				const session = yield* devSessions.createSession;

				const prepared = yield* prepareSessionPglite(session, {
					migrationsFolder,
				});

				expect(prepared.dataDir).toBe(join(storageDir, session.name, 'pglite'));
				expect(prepared.dumpPath).toBe(
					join(storageDir, session.name, 'pglite.dump'),
				);

				const client = new PGlite(prepared.dataDir);
				const count = yield* getDbMigrationCount(client);
				expect(count).toBe(1);

				yield* closeClient(client);
			}),
		),
	);
});
