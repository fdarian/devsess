import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from '@effect/vitest';
import { PGlite } from '@electric-sql/pglite';
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
import { makeTestDevSessionsLayer } from '../support/dev-sessions-layer';
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

					yield* migratePglite(client, migrationsFolder);

					const after = yield* Effect.promise(newTableQuery);
					expect(after.rows[0]?.exists).toBe(true);

					yield* closeClient(client);
				}),
			),
	);
});

describe('getExpectedMigrationCount', () => {
	it.effect('fails with PgliteError when meta/_journal.json is missing', () =>
		runTest(
			Effect.gen(function* () {
				const rootDir = yield* makeTempDir;

				const error = yield* getExpectedMigrationCount(rootDir).pipe(
					Effect.flip,
				);

				expect(error).toBeInstanceOf(PgliteError);
				expect(error.message).toContain('Migration journal not found');
			}),
		),
	);

	it.effect('fails with PgliteError when the journal is unparseable JSON', () =>
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
				expect(error.message).toContain('Failed to parse migration journal');
			}),
		),
	);

	it.effect(
		'fails with PgliteError when the journal has no entries field',
		() =>
			runTest(
				Effect.gen(function* () {
					const rootDir = yield* makeTempDir;
					yield* Effect.promise(() =>
						mkdir(join(rootDir, 'meta'), { recursive: true }),
					);
					yield* Effect.promise(() =>
						writeFile(
							join(rootDir, 'meta/_journal.json'),
							JSON.stringify({ version: '7', dialect: 'postgresql' }),
						),
					);

					const error = yield* getExpectedMigrationCount(rootDir).pipe(
						Effect.flip,
					);

					expect(error).toBeInstanceOf(PgliteError);
					expect(error.message).toContain('missing an "entries" array');
				}),
			),
	);

	it.effect('fails with PgliteError when entries is not an array', () =>
		runTest(
			Effect.gen(function* () {
				const rootDir = yield* makeTempDir;
				yield* Effect.promise(() =>
					mkdir(join(rootDir, 'meta'), { recursive: true }),
				);
				yield* Effect.promise(() =>
					writeFile(
						join(rootDir, 'meta/_journal.json'),
						JSON.stringify({
							version: '7',
							dialect: 'postgresql',
							entries: 'nope',
						}),
					),
				);

				const error = yield* getExpectedMigrationCount(rootDir).pipe(
					Effect.flip,
				);

				expect(error).toBeInstanceOf(PgliteError);
				expect(error.message).toContain('missing an "entries" array');
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

				const sessionsDir = join(rootDir, 'sessions');
				const devSessions = yield* DevSessions.pipe(
					Effect.provide(makeTestDevSessionsLayer(sessionsDir)),
				);
				const session = yield* devSessions.createSession;

				const { client, dataDir, dumpPath } = yield* prepareSessionPglite(
					session,
					{
						migrationsFolder,
					},
				);

				expect(dataDir).toBe(join(sessionsDir, session.name, 'pglite'));
				expect(dumpPath).toBe(join(sessionsDir, session.name, 'pglite.dump'));

				const count = yield* getDbMigrationCount(client);
				expect(count).toBe(1);

				yield* closeClient(client);
			}),
		),
	);
});
