import { watch as fsWatch, realpathSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { Deferred, Effect } from 'effect';
import { FileSystem } from 'effect/FileSystem';
import { Path } from 'effect/Path';

const RUNNING_SIGNAL_FILE = '.data/running.json';

/** Path to the running-signal file for a dev-session (or sibling package) directory. */
export const runningSignalPath = (dir: string) =>
	join(dir, RUNNING_SIGNAL_FILE);

/**
 * Resolves `spec` to a directory: relative/absolute paths are resolved against
 * `fromDir`, anything else is treated as a package name and resolved via its
 * `package.json`.
 */
export const resolveSiblingDir = (spec: string, fromDir: string) => {
	if (spec.startsWith('.') || spec.startsWith('/')) {
		return resolve(fromDir, spec);
	}
	const require = createRequire(join(fromDir, 'package.json'));
	const pkgJsonPath = require.resolve(`${spec}/package.json`);
	return dirname(realpathSync(pkgJsonPath));
};

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
				yield* fs.remove(filePath).pipe(Effect.catch(() => Effect.void));
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
					.pipe(Effect.catch(() => Effect.succeed(null)));
				if (raw == null) return false;
				const parsed = yield* Effect.try(() => opts.parse(raw)).pipe(
					Effect.catch(() => Effect.succeed(null)),
				);
				if (parsed == null) return false;
				yield* Deferred.succeed(deferred, parsed);
				return true;
			});

			// fsWatch throws synchronously if `dir` doesn't exist yet — e.g. a sibling
			// package's dev script has never run — so ensure it's there first.
			yield* fs.makeDirectory(dir, { recursive: true });

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
