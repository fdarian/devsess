import { Array as A, Context, Effect, Layer, Option } from 'effect';
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
>()('devsess/DevSessions') {}

export const makeDevSessionsLayer = (rootDir: string) =>
	Layer.effect(
		DevSessions,
		Effect.gen(function* () {
			const fs = yield* FileSystem;
			const path = yield* Path;

			yield* Effect.logDebug(`DevSessions dir: ${rootDir}`);
			const getPath = (relativePath: string) =>
				path.join(rootDir, relativePath);

			const getSessions = Effect.gen(function* () {
				const entries = yield* fs
					.readDirectory(rootDir)
					.pipe(Effect.catch(() => Effect.succeed([] as Array<string>)));

				const possibleSessions = yield* Effect.all(
					entries.map((entry) =>
						Effect.gen(function* () {
							const stat = yield* fs.stat(getPath(entry));
							if (stat.type !== 'Directory') return Option.none();
							return Option.some(
								DevSession.make({
									name: entry,
									lastModifiedAt: Option.getOrNull(stat.mtime),
									rootDir,
									pathJoin: (relativePath: string) =>
										path.join(rootDir, entry, relativePath),
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
				yield* fs.makeDirectory(getPath(slug), { recursive: true });
				return DevSession.make({
					name: slug,
					lastModifiedAt: null,
					rootDir,
					pathJoin: (relativePath: string) =>
						path.join(rootDir, slug, relativePath),
				});
			});

			return {
				dir: rootDir,
				path: getPath,
				getSessions,
				createSession,
				getLatestOrCreate: Effect.gen(function* () {
					yield* fs.makeDirectory(rootDir, { recursive: true });

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
				}),
			};
		}),
	);
