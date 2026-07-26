import { Effect } from 'effect';
import { ChildProcess } from 'effect/unstable/process';

export const runManagedSubprocess = (
	cmd: string,
	args: string[],
	opts?: { env?: Record<string, string> },
) =>
	Effect.gen(function* () {
		const command = ChildProcess.make(cmd, args, {
			stdin: 'inherit',
			stdout: 'inherit',
			stderr: 'inherit',
			env: { ...process.env, ...(opts?.env ?? {}) },
		});

		const label = [cmd, ...args].join(' ');

		// Registers against the ambient scope, not a scope of its own — the
		// child must outlive this call (it doesn't resolve until the child
		// exits) and get killed only when the caller's scope closes.
		const child = yield* Effect.acquireRelease(
			Effect.gen(function* () {
				const proc = yield* command;
				yield* Effect.logInfo(`[dev] started: ${label} (pid=${proc.pid})`);
				return proc;
			}),
			(proc) =>
				Effect.gen(function* () {
					yield* Effect.logInfo(`[dev] stopping: ${label} (pid=${proc.pid})`);
					yield* proc
						.kill()
						.pipe(
							Effect.catch((err) =>
								Effect.logError(
									`[dev] failed to stop ${label} (pid=${proc.pid}): ${err}`,
								),
							),
						);
				}),
		);

		return yield* child.exitCode;
	});
