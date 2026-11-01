import { Effect, Schedule } from 'effect';
import lockfile from 'proper-lockfile';

export const acquireFileLock = (file: string, lockPath = `${file}.lock`) =>
	Effect.tryPromise({
		try: () =>
			lockfile.lock(file, {
				realpath: false,
				lockfilePath: lockPath,
				stale: 60_000,
				retries: 0,
			}),
		catch: (cause) => new Error(`Failed to lock ${file}`, { cause }),
	}).pipe(
		Effect.retry({
			while: (error) =>
				typeof error.cause === 'object' &&
				error.cause !== null &&
				'code' in error.cause &&
				error.cause.code === 'ELOCKED',
			schedule: Schedule.spaced('50 millis'),
		}),
	);
