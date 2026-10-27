import { Effect, Schema } from 'effect';

export const PROCESS_EXIT_POLL_INTERVAL_MS = 50;
export const PROCESS_TERM_TIMEOUT_MS = 5_000;
export const PROCESS_KILL_TIMEOUT_MS = 2_000;

export class DaemonTerminationError extends Schema.TaggedError<DaemonTerminationError>()(
	'devsess/cli/DaemonTerminationError',
	{ message: Schema.String, cause: Schema.optional(Schema.Defect()) },
) {}

const isMissingProcess = (cause: unknown) =>
	cause instanceof Error && 'code' in cause && cause.code === 'ESRCH';

export const isProcessAlive = (pid: number) =>
	Effect.try({
		try: () => {
			try {
				process.kill(pid, 0);
				return true;
			} catch (cause) {
				if (isMissingProcess(cause)) return false;
				throw cause;
			}
		},
		catch: (cause) =>
			new DaemonTerminationError({
				message: `Could not check whether daemon PID ${pid} is running`,
				cause,
			}),
	});

export const signalProcess = (pid: number, signal: 'SIGTERM' | 'SIGKILL') =>
	Effect.try({
		try: () => {
			try {
				process.kill(pid, signal);
			} catch (cause) {
				if (isMissingProcess(cause)) return;
				throw cause;
			}
		},
		catch: (cause) =>
			new DaemonTerminationError({
				message: `Could not send ${signal} to daemon PID ${pid}`,
				cause,
			}),
	});

export const waitForProcessExit = (
	pid: number,
	deadline: number,
): Effect.Effect<boolean, DaemonTerminationError> =>
	Effect.gen(function* () {
		if (!(yield* isProcessAlive(pid))) return true;
		if (Date.now() >= deadline) return false;
		yield* Effect.sleep(`${PROCESS_EXIT_POLL_INTERVAL_MS} millis`);
		return yield* waitForProcessExit(pid, deadline);
	});

/** Escalates SIGTERM to SIGKILL and reports which signal ended the process; fails if it survives SIGKILL. */
export const terminateProcess = (
	pid: number,
	termTimeoutMs = PROCESS_TERM_TIMEOUT_MS,
) =>
	Effect.gen(function* () {
		yield* signalProcess(pid, 'SIGTERM');
		if (yield* waitForProcessExit(pid, Date.now() + termTimeoutMs))
			return 'SIGTERM' as const;
		yield* signalProcess(pid, 'SIGKILL');
		if (!(yield* waitForProcessExit(pid, Date.now() + PROCESS_KILL_TIMEOUT_MS)))
			return yield* new DaemonTerminationError({
				message: `Daemon PID ${pid} survived SIGKILL`,
			});
		return 'SIGKILL' as const;
	});
