import { Effect } from 'effect';
import { FileSystem } from 'effect/FileSystem';
import { Path } from 'effect/Path';

export const findSharedRoot = (projectDir: string) =>
	Effect.gen(function* () {
		const fs = yield* FileSystem;
		const path = yield* Path;
		const start = path.resolve(projectDir);
		const walk = (
			dir: string,
			candidate: string,
		): Effect.Effect<string, import('effect/PlatformError').PlatformError> =>
			Effect.gen(function* () {
				const topmost = yield* fs.exists(path.join(dir, 'package.json'));
				const next = topmost ? dir : candidate;
				if (yield* fs.exists(path.join(dir, '.git'))) return next;
				const parent = path.dirname(dir);
				if (parent === dir) return start;
				return yield* walk(parent, next);
			});
		return yield* walk(start, start);
	});
