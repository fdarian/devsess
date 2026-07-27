import { realpathSync } from 'node:fs';
import { join } from 'node:path';
import { NodeServices } from '@effect/platform-node';
import { describe, expect, it } from '@effect/vitest';
import { Effect, Layer, Option } from 'effect';
import { FileSystem } from 'effect/FileSystem';
import { generateSlug } from 'random-word-slugs';
import { vi } from 'vitest';
import { DevSessions, ProjectRootNotFoundError } from '../src/dev-sessions';
import {
	makeTestDevSessionsLayer,
	sessionsStorageDir,
} from './support/dev-sessions-layer';
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
				const storageDir = sessionsStorageDir(rootDir);
				const fs = yield* FileSystem;

				yield* fs.makeDirectory(join(storageDir, 'older'), {
					recursive: true,
				});
				yield* fs.makeDirectory(join(storageDir, 'newer'), {
					recursive: true,
				});
				yield* fs.utimes(
					join(storageDir, 'older'),
					new Date('2020-01-01'),
					new Date('2020-01-01'),
				);
				yield* fs.utimes(
					join(storageDir, 'newer'),
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
				const storageDir = sessionsStorageDir(rootDir);
				const fs = yield* FileSystem;

				// Both dirs are created "now", so without the mtime override the
				// null-mtime dir would actually look newest.
				yield* fs.makeDirectory(join(storageDir, 'null-mtime'), {
					recursive: true,
				});
				yield* fs.makeDirectory(join(storageDir, 'old-but-real-mtime'), {
					recursive: true,
				});
				yield* fs.utimes(
					join(storageDir, 'old-but-real-mtime'),
					new Date('2020-01-01'),
					new Date('2020-01-01'),
				);

				// `withNullMtime` must come last: `Layer.merge` resolves colliding tags
				// (here, `FileSystem`) in favor of the later layer.
				const devSessionsLayer = DevSessions.layerAt(rootDir).pipe(
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

				expect(yield* fs.exists(sessionsStorageDir(missingRoot))).toBe(true);
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
				const storageDir = sessionsStorageDir(rootDir);
				const fs = yield* FileSystem;
				yield* fs.makeDirectory(join(storageDir, 'a-session'), {
					recursive: true,
				});
				yield* fs.writeFileString(
					join(storageDir, 'stray-file.txt'),
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
				const storageDir = sessionsStorageDir(rootDir);
				const fs = yield* FileSystem;
				const names = Array.from({ length: 25 }, (_, i) => `session-${i}`);
				yield* Effect.all(
					names.map((name) =>
						fs.makeDirectory(join(storageDir, name), { recursive: true }),
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
				expect(
					yield* fs.exists(join(sessionsStorageDir(nestedRoot), 'fresh-otter')),
				).toBe(true);
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

				expect(resolved).toBe(
					join(sessionsStorageDir(rootDir), 'quiet-otter', 'nested/db.sqlite'),
				);
				expect(yield* fs.exists(resolved)).toBe(false);
			}),
		),
	);
});

describe('DevSessions.layerAt', () => {
	it.effect(
		'dir/path resolve against rootDir itself, while sessions live under .data/sessions',
		() =>
			runTest(
				Effect.gen(function* () {
					vi.mocked(generateSlug).mockClear();
					vi.mocked(generateSlug).mockReturnValueOnce('rooted-otter');
					const rootDir = yield* makeTempDir;
					const fs = yield* FileSystem;

					const devSessions = yield* DevSessions.pipe(
						Effect.provide(DevSessions.layerAt(rootDir)),
					);

					expect(devSessions.dir).toBe(rootDir);
					expect(devSessions.path('drizzle')).toBe(join(rootDir, 'drizzle'));

					const session = yield* devSessions.createSession;
					expect(session.name).toBe('rooted-otter');
					expect(
						yield* fs.exists(join(sessionsStorageDir(rootDir), 'rooted-otter')),
					).toBe(true);
				}),
			),
	);

	it.effect(
		'merely providing the layer does not touch the session store (no eager CurrentSession)',
		() =>
			runTest(
				Effect.gen(function* () {
					vi.mocked(generateSlug).mockClear();
					const rootDir = yield* makeTempDir;
					const fs = yield* FileSystem;

					yield* DevSessions.pipe(Effect.provide(DevSessions.layerAt(rootDir)));

					expect(yield* fs.exists(sessionsStorageDir(rootDir))).toBe(false);
					expect(generateSlug).not.toHaveBeenCalled();
				}),
			),
	);
});

describe('DevSessions.layer', () => {
	it.effect(
		'auto-detects the project root by walking up from cwd to the nearest package.json',
		() =>
			runTest(
				Effect.gen(function* () {
					// macOS's tmp dir is a symlink (`/var/...` -> `/private/var/...`), and
					// `process.cwd()` resolves it — normalize both sides before comparing.
					const rootDir = realpathSync(yield* makeTempDir);
					const fs = yield* FileSystem;
					const nested = join(rootDir, 'apps', 'web');
					yield* fs.makeDirectory(nested, { recursive: true });
					yield* fs.writeFileString(join(rootDir, 'package.json'), '{}');

					const originalCwd = process.cwd();
					process.chdir(nested);
					try {
						const devSessions = yield* DevSessions.pipe(
							Effect.provide(DevSessions.layer),
						);
						expect(devSessions.dir).toBe(rootDir);
					} finally {
						process.chdir(originalCwd);
					}
				}),
			),
	);

	it.effect(
		'fails with ProjectRootNotFoundError naming the search start when no ancestor has a package.json',
		() =>
			runTest(
				Effect.gen(function* () {
					const rootDir = realpathSync(yield* makeTempDir);

					const originalCwd = process.cwd();
					process.chdir(rootDir);
					try {
						const error = yield* DevSessions.pipe(
							Effect.provide(DevSessions.layer),
							Effect.flip,
						);
						expect(error).toBeInstanceOf(ProjectRootNotFoundError);
						expect((error as ProjectRootNotFoundError).searchedFrom).toBe(
							rootDir,
						);
					} finally {
						process.chdir(originalCwd);
					}
				}),
			),
	);
});
