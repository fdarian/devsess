import { join } from 'node:path';
import { NodeServices } from '@effect/platform-node';
import { describe, expect, it } from '@effect/vitest';
import { Effect, Layer, Option } from 'effect';
import { FileSystem } from 'effect/FileSystem';
import { generateSlug } from 'random-word-slugs';
import { vi } from 'vitest';
import { DevSessions, makeDevSessionsLayer } from '../src/dev-sessions';
import { makeTestDevSessionsLayer } from './support/dev-sessions-layer';
import { runTest } from './support/run-test';
import { makeTempDir } from './support/temp-dir';

/**
 * Wraps the real `FileSystem`, forcing `stat().mtime` to `Option.none()` for any path
 * ending in `targetName`. Used to exercise the null-mtime branch of `getLatestOrCreate`,
 * which real directories can't otherwise produce.
 */
const withNullMtime = (targetName: string) =>
	Layer.effect(
		FileSystem,
		Effect.gen(function* () {
			const fs = yield* FileSystem;
			return {
				...fs,
				stat: (path: string) =>
					fs
						.stat(path)
						.pipe(
							Effect.map((info) =>
								path.endsWith(targetName)
									? { ...info, mtime: Option.none() }
									: info,
							),
						),
			};
		}),
	).pipe(Layer.provide(NodeServices.layer));

describe('getLatestOrCreate', () => {
	it.effect('creates a session in an empty dir', () =>
		runTest(
			Effect.gen(function* () {
				vi.mocked(generateSlug).mockReturnValueOnce('brave-otter');

				const rootDir = yield* makeTempDir;
				const devSessions = yield* DevSessions.pipe(
					Effect.provide(makeTestDevSessionsLayer(rootDir)),
				);

				const session = yield* devSessions.getLatestOrCreate;

				expect(session.name).toBe('brave-otter');
				expect(session.lastModifiedAt).toBeNull();
			}),
		),
	);

	it.effect('reuses the most recently modified session on a second call', () =>
		runTest(
			Effect.gen(function* () {
				const rootDir = yield* makeTempDir;
				const devSessions = yield* DevSessions.pipe(
					Effect.provide(makeTestDevSessionsLayer(rootDir)),
				);

				const first = yield* devSessions.getLatestOrCreate;
				const second = yield* devSessions.getLatestOrCreate;

				expect(second.name).toBe(first.name);
			}),
		),
	);

	it.effect('picks the most recently modified session when several exist', () =>
		runTest(
			Effect.gen(function* () {
				const rootDir = yield* makeTempDir;
				const fs = yield* FileSystem;

				yield* fs.makeDirectory(join(rootDir, 'older'), { recursive: true });
				yield* fs.makeDirectory(join(rootDir, 'newer'), { recursive: true });
				yield* fs.utimes(
					join(rootDir, 'older'),
					new Date('2020-01-01'),
					new Date('2020-01-01'),
				);
				yield* fs.utimes(
					join(rootDir, 'newer'),
					new Date('2024-01-01'),
					new Date('2024-01-01'),
				);

				const devSessions = yield* DevSessions.pipe(
					Effect.provide(makeTestDevSessionsLayer(rootDir)),
				);
				const session = yield* devSessions.getLatestOrCreate;

				expect(session.name).toBe('newer');
			}),
		),
	);

	it.effect('treats a null mtime as older than any real timestamp', () =>
		runTest(
			Effect.gen(function* () {
				const rootDir = yield* makeTempDir;
				const fs = yield* FileSystem;

				// Both dirs are created "now", so without the mtime override the
				// null-mtime dir would actually look newest.
				yield* fs.makeDirectory(join(rootDir, 'null-mtime'), {
					recursive: true,
				});
				yield* fs.makeDirectory(join(rootDir, 'old-but-real-mtime'), {
					recursive: true,
				});
				yield* fs.utimes(
					join(rootDir, 'old-but-real-mtime'),
					new Date('2020-01-01'),
					new Date('2020-01-01'),
				);

				// `withNullMtime` must come last: `Layer.merge` resolves colliding tags
				// (here, `FileSystem`) in favor of the later layer.
				const devSessionsLayer = makeDevSessionsLayer(rootDir).pipe(
					Layer.provide(
						Layer.merge(NodeServices.layer, withNullMtime('null-mtime')),
					),
				);
				const devSessions = yield* DevSessions.pipe(
					Effect.provide(devSessionsLayer),
				);
				const session = yield* devSessions.getLatestOrCreate;

				expect(session.name).toBe('old-but-real-mtime');
			}),
		),
	);

	it.effect('creates the root dir if it does not exist', () =>
		runTest(
			Effect.gen(function* () {
				const rootDir = yield* makeTempDir;
				const missingRoot = join(rootDir, 'nested', 'sessions');
				const devSessions = yield* DevSessions.pipe(
					Effect.provide(makeTestDevSessionsLayer(missingRoot)),
				);
				const fs = yield* FileSystem;

				yield* devSessions.getLatestOrCreate;

				expect(yield* fs.exists(missingRoot)).toBe(true);
			}),
		),
	);
});

describe('getSessions', () => {
	it.effect('returns [] when the root dir does not exist', () =>
		runTest(
			Effect.gen(function* () {
				const rootDir = yield* makeTempDir;
				const missingRoot = join(rootDir, 'does-not-exist');
				const devSessions = yield* DevSessions.pipe(
					Effect.provide(makeTestDevSessionsLayer(missingRoot)),
				);

				const sessions = yield* devSessions.getSessions;

				expect(sessions).toEqual([]);
			}),
		),
	);

	it.effect('ignores non-directory entries in the root dir', () =>
		runTest(
			Effect.gen(function* () {
				const rootDir = yield* makeTempDir;
				const fs = yield* FileSystem;
				yield* fs.makeDirectory(join(rootDir, 'a-session'), {
					recursive: true,
				});
				yield* fs.writeFileString(
					join(rootDir, 'stray-file.txt'),
					'not a session',
				);

				const devSessions = yield* DevSessions.pipe(
					Effect.provide(makeTestDevSessionsLayer(rootDir)),
				);
				const sessions = yield* devSessions.getSessions;

				expect(sessions.map((session) => session.name)).toEqual(['a-session']);
			}),
		),
	);

	it.effect('stays correct with many session dirs', () =>
		runTest(
			Effect.gen(function* () {
				const rootDir = yield* makeTempDir;
				const fs = yield* FileSystem;
				const names = Array.from({ length: 25 }, (_, i) => `session-${i}`);
				yield* Effect.all(
					names.map((name) =>
						fs.makeDirectory(join(rootDir, name), { recursive: true }),
					),
					{ concurrency: 'unbounded' },
				);

				const devSessions = yield* DevSessions.pipe(
					Effect.provide(makeTestDevSessionsLayer(rootDir)),
				);
				const sessions = yield* devSessions.getSessions;

				expect(sessions.map((session) => session.name).sort()).toEqual(
					names.sort(),
				);
			}),
		),
	);
});

describe('createSession', () => {
	it.effect('creates the session dir recursively', () =>
		runTest(
			Effect.gen(function* () {
				vi.mocked(generateSlug).mockReturnValueOnce('fresh-otter');
				const rootDir = yield* makeTempDir;
				const nestedRoot = join(rootDir, 'nested', 'sessions');
				const devSessions = yield* DevSessions.pipe(
					Effect.provide(makeTestDevSessionsLayer(nestedRoot)),
				);
				const fs = yield* FileSystem;

				const session = yield* devSessions.createSession;

				expect(session.name).toBe('fresh-otter');
				expect(yield* fs.exists(join(nestedRoot, 'fresh-otter'))).toBe(true);
			}),
		),
	);
});

describe('DevSession.path', () => {
	it.effect('returns a joined path without touching the filesystem', () =>
		runTest(
			Effect.gen(function* () {
				vi.mocked(generateSlug).mockReturnValueOnce('quiet-otter');
				const rootDir = yield* makeTempDir;
				const devSessions = yield* DevSessions.pipe(
					Effect.provide(makeTestDevSessionsLayer(rootDir)),
				);
				const fs = yield* FileSystem;

				const session = yield* devSessions.createSession;
				const resolved = yield* session.path('nested/db.sqlite');

				expect(resolved).toBe(join(rootDir, 'quiet-otter', 'nested/db.sqlite'));
				expect(yield* fs.exists(resolved)).toBe(false);
			}),
		),
	);
});
