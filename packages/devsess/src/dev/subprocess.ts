import * as CommandModule from '@effect/platform/Command';
import { Effect, pipe } from 'effect';

export const runManagedSubprocess = (
	cmd: string,
	args: string[],
	opts?: { env?: Record<string, string> },
) =>
	Effect.scoped(
		Effect.gen(function* () {
			const command = pipe(
				CommandModule.make(cmd, ...args),
				CommandModule.stdin('inherit'),
				CommandModule.stdout('inherit'),
				CommandModule.stderr('inherit'),
				CommandModule.env({ ...process.env, ...(opts?.env ?? {}) }),
			);

			const label = [cmd, ...args].join(' ');

			const child = yield* Effect.acquireRelease(
				Effect.gen(function* () {
					const proc = yield* CommandModule.start(command);
					yield* Effect.logInfo(`[dev] started: ${label} (pid=${proc.pid})`);
					return proc;
				}),
				(proc) =>
					Effect.gen(function* () {
						yield* Effect.logInfo(`[dev] stopping: ${label} (pid=${proc.pid})`);
						yield* proc
							.kill()
							.pipe(
								Effect.catchAll((err) =>
									Effect.logError(
										`[dev] failed to stop ${label} (pid=${proc.pid}): ${err}`,
									),
								),
							);
					}),
			);

			return yield* child.exitCode;
		}),
	);
