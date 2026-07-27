import { Array as A, Context, Data, Effect, Layer, Option } from 'effect';
import { FileSystem } from 'effect/FileSystem';
import { Path } from 'effect/Path';
import type { PlatformError } from 'effect/PlatformError';
import { generateSlug } from 'random-word-slugs';

namespace DevSession {
	type DevSessionInput = {
		name: string;
		lastModifiedAt: Date | null;
		rootDir: string;
		pathJoin: (relativePath: string) => string;
	};

	export function make(input: DevSessionInput) {
		return {
			name: input.name,
			lastModifiedAt: input.lastModifiedAt,
			path: (relativePath: string) =>
				Effect.succeed(input.pathJoin(relativePath)),
			toString: () => input.name,
		};
	}
}

export type DevSession = ReturnType<typeof DevSession.make>;

export class DevSessions extends Context.Service<
	DevSessions,
	{
		readonly dir: string;
		readonly path: (relativePath: string) => string;
		readonly getSessions: Effect.Effect<Array<DevSession>, PlatformError>;
		readonly createSession: Effect.Effect<DevSession, PlatformError>;
		readonly getLatestOrCreate: Effect.Effect<DevSession, PlatformError>;
	}
>()('devsess/DevSessions') {
	/**
	 * `DevSessions` explicitly rooted at `rootDir`: `dir`/`path` resolve against `rootDir`
	 * itself (e.g. `sessions.path('drizzle')` reaches a project's real `drizzle/` folder),
	 * while session directories are namespaced under `<rootDir>/.data/sessions`.
	 *
	 * Deliberately does *not* also provide `CurrentSession` — a `Layer`'s build effect
	 * runs as soon as it's provided, before anything downstream (e.g. `cli.Command.run`'s
	 * argv parsing) gets a say. Bundling session resolution in here would create a
	 * session for `--help`/`--version`/a bad flag too, since those never reach a command
	 * handler at all. Provide `CurrentSession.layer` around the handler itself instead.
	 */
	static readonly layerAt = (rootDir: string) => buildDevSessionsLayer(rootDir);

	/**
	 * `DevSessions.layerAt` rooted at the auto-detected project root — the nearest
	 * ancestor of `process.cwd()` containing a `package.json`.
	 */
	static readonly layer: Layer.Layer<
		DevSessions,
		PlatformError | ProjectRootNotFoundError,
		FileSystem | Path
	> = Layer.unwrap(
		Effect.suspend(() =>
			Effect.map(findProjectRoot, (rootDir) => DevSessions.layerAt(rootDir)),
		),
	);
}

/**
 * Raised by `DevSessions.layer` when no ancestor of `searchedFrom` contains a
 * `package.json`. Failing loudly beats silently falling back to `process.cwd()` — a
 * wrong root means dev sessions get written to a surprising place.
 */
export class ProjectRootNotFoundError extends Data.TaggedError(
	'ProjectRootNotFoundError',
)<{
	readonly searchedFrom: string;
}> {}

/** Walks up from `process.cwd()` to the nearest ancestor containing a `package.json`. */
const findProjectRoot = Effect.gen(function* () {
	const fs = yield* FileSystem;
	const path = yield* Path;
	const startDir = process.cwd();

	const walkUp = (
		dir: string,
	): Effect.Effect<string, PlatformError | ProjectRootNotFoundError> =>
		Effect.gen(function* () {
			if (yield* fs.exists(path.join(dir, 'package.json'))) {
				return dir;
			}
			const parent = path.dirname(dir);
			if (parent === dir) {
				return yield* Effect.fail(
					new ProjectRootNotFoundError({ searchedFrom: startDir }),
				);
			}
			return yield* walkUp(parent);
		});

	return yield* walkUp(startDir);
});

/** The listing/creation logic shared by every `DevSessions` layer, parameterized on the literal directory session subdirs live under. */
const buildDevSessionsCore = (sessionsDir: string) =>
	Effect.gen(function* () {
		const fs = yield* FileSystem;
		const path = yield* Path;

		yield* Effect.logDebug(`DevSessions dir: ${sessionsDir}`);

		const getSessions = Effect.gen(function* () {
			const entries = yield* fs
				.readDirectory(sessionsDir)
				.pipe(Effect.catch(() => Effect.succeed([] as Array<string>)));

			const possibleSessions = yield* Effect.all(
				entries.map((entry) =>
					Effect.gen(function* () {
						const stat = yield* fs.stat(path.join(sessionsDir, entry));
						if (stat.type !== 'Directory') return Option.none();
						return Option.some(
							DevSession.make({
								name: entry,
								lastModifiedAt: Option.getOrNull(stat.mtime),
								rootDir: sessionsDir,
								pathJoin: (relativePath: string) =>
									path.join(sessionsDir, entry, relativePath),
							}),
						);
					}),
				),
				{ concurrency: 'unbounded' },
			);

			return A.getSomes(possibleSessions);
		});

		const createSession = Effect.gen(function* () {
			const slug = generateSlug(1, { partsOfSpeech: ['noun'] });
			yield* fs.makeDirectory(path.join(sessionsDir, slug), {
				recursive: true,
			});
			return DevSession.make({
				name: slug,
				lastModifiedAt: null,
				rootDir: sessionsDir,
				pathJoin: (relativePath: string) =>
					path.join(sessionsDir, slug, relativePath),
			});
		});

		const getLatestOrCreate = Effect.gen(function* () {
			yield* fs.makeDirectory(sessionsDir, { recursive: true });

			const sessions = yield* getSessions;
			if (sessions.length > 0) {
				sessions.sort(
					(a, b) =>
						(b.lastModifiedAt?.getTime() ?? 0) -
						(a.lastModifiedAt?.getTime() ?? 0),
				);
				const latest = sessions[0];
				return latest as DevSession;
			}

			return yield* createSession;
		});

		return { getSessions, createSession, getLatestOrCreate };
	});

/**
 * The one `DevSessions` layer constructor: `dir`/`path` resolve against `rootDir`
 * itself, while session directories are namespaced under `<rootDir>/.data/sessions` —
 * the library owns that layout, so every caller (`DevSessions.layerAt`, the async
 * facade's `createDevSessions`) means the same thing by `rootDir`.
 */
const buildDevSessionsLayer = (rootDir: string) =>
	Layer.effect(
		DevSessions,
		Effect.gen(function* () {
			const path = yield* Path;
			const sessionsDir = path.join(rootDir, '.data', 'sessions');
			const core = yield* buildDevSessionsCore(sessionsDir);
			return {
				dir: rootDir,
				path: (relativePath: string) => path.join(rootDir, relativePath),
				...core,
			};
		}),
	);
