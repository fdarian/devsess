import { watch as fsWatch } from 'node:fs';
import { FileSystem } from '@effect/platform/FileSystem';
import { Path } from '@effect/platform/Path';
import { Deferred, Effect } from 'effect';

/** Atomically writes `value` as JSON to `filePath` and removes it on release. */
export const publishRunningSignal = (filePath: string, value: unknown) =>
	Effect.acquireRelease(
		Effect.gen(function* () {
			const fs = yield* FileSystem;
			const path = yield* Path;
			const tmp = `${filePath}.tmp`;
			yield* fs.makeDirectory(path.dirname(filePath), { recursive: true });
			// Write to a temp file then rename atomically so readers never see a partial file.
			yield* fs.writeFileString(tmp, JSON.stringify(value));
			yield* fs.rename(tmp, filePath);
		}),
		() =>
			Effect.gen(function* () {
				const fs = yield* FileSystem;
				yield* fs.remove(filePath).pipe(Effect.catchAll(() => Effect.void));
			}),
	);

/** Watches parent directory for the signal file and resolves once it can be parsed. */
export const awaitRunningSignal = <T>(
	filePath: string,
	opts: { parse: (raw: string) => T },
) =>
	Effect.scoped(
		Effect.gen(function* () {
			const fs = yield* FileSystem;
			const path = yield* Path;
			const dir = path.dirname(filePath);
			const filename = path.basename(filePath);

			const deferred = yield* Deferred.make<T>();

			const tryRead = Effect.gen(function* () {
				if (!(yield* fs.exists(filePath))) return false;
				const raw = yield* fs
					.readFileString(filePath)
					.pipe(Effect.catchAll(() => Effect.succeed(null)));
				if (raw == null) return false;
				const parsed = yield* Effect.try(() => opts.parse(raw)).pipe(
					Effect.catchAll(() => Effect.succeed(null)),
				);
				if (parsed == null) return false;
				yield* Deferred.succeed(deferred, parsed);
				return true;
			});

			yield* Effect.acquireRelease(
				Effect.sync(() =>
					// Watch parent dir — the file may not exist yet, and watching a missing file errors.
					fsWatch(dir, { recursive: false }, (eventType, eventFilename) => {
						if (eventFilename !== filename) return;
						if (eventType !== 'rename' && eventType !== 'change') return;
						Effect.runFork(tryRead);
					}),
				),
				(watcher) => Effect.sync(() => watcher.close()),
			);

			yield* tryRead;
			return yield* Deferred.await(deferred);
		}),
	);
