import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { Context, Effect, Layer, Schema, Semaphore } from 'effect';
import {
	GROUP_LIVENESS_BACKOFF_INITIAL_MS,
	GROUP_LIVENESS_BACKOFF_MAX_MS,
	PROCESS_INSPECTION_TIMEOUT_MS,
	TERMINATION_KILL_SIGNAL,
	TERMINATION_POLL_ATTEMPTS,
	TERMINATION_POLL_INTERVAL_MS,
	TERMINATION_TERM_SIGNAL,
} from './termination';

export type ProcessIdentity = {
	readonly pid: number;
	readonly processGroupId: number;
	/** Process birth fingerprint. Linux uses `/proc` clock ticks; macOS falls back to `ps lstart` seconds. */
	readonly startedAt: string;
};

export type LiveProcessOwnership = {
	readonly identity: ProcessIdentity;
	readonly terminate: Effect.Effect<number | undefined, ProcessError>;
};

export class ProcessError extends Schema.TaggedErrorClass<ProcessError>()(
	'ProcessError',
	{
		message: Schema.String,
		cause: Schema.optional(Schema.Defect()),
	},
) {}

const readMacProcess = (pid: number) =>
	Effect.tryPromise({
		try: () =>
			new Promise<
				Readonly<{ processGroupId: number; startedAt: string }> | undefined
			>((resolve, reject) => {
				execFile(
					'ps',
					['-o', 'pgid=', '-o', 'lstart=', '-p', String(pid)],
					{ timeout: PROCESS_INSPECTION_TIMEOUT_MS },
					(error, stdout) => {
						if (error !== null) {
							const nodeError = error as NodeJS.ErrnoException;
							const exitCode = (
								error as NodeJS.ErrnoException & { code?: string | number }
							).code;
							if (
								nodeError.code === 'ESRCH' ||
								nodeError.code === 'ENOENT' ||
								Number(exitCode) === 1
							) {
								resolve(undefined);
								return;
							}
							reject(error);
							return;
						}
						const match = /^\s*(\d+)\s+(.+?)\s*$/.exec(stdout);
						if (
							match === null ||
							match[1] === undefined ||
							match[2] === undefined
						) {
							resolve(undefined);
							return;
						}
						const processGroupId = Number(match[1]);
						if (!isSafeProcessId(processGroupId)) {
							reject(new Error(`Process ${pid} has an invalid process group`));
							return;
						}
						resolve({ processGroupId, startedAt: match[2] });
					},
				);
			}),
		catch: (cause) =>
			new ProcessError({ message: `Could not inspect process ${pid}`, cause }),
	});

const readLinuxProcess = (pid: number) =>
	Effect.tryPromise({
		try: async () => {
			try {
				const stat = await readFile(`/proc/${pid}/stat`, 'utf8');
				const closingParen = stat.lastIndexOf(')');
				const fields = stat
					.slice(closingParen + 2)
					.trim()
					.split(/\s+/);
				const processGroupId = Number(fields[2]);
				const startTicks = fields[19];
				if (!isSafeProcessId(processGroupId) || startTicks === undefined) {
					throw new Error(`Process ${pid} has invalid Linux process metadata`);
				}
				return { processGroupId, startedAt: `linux:${startTicks}` };
			} catch (cause) {
				if (
					cause instanceof Error &&
					'code' in cause &&
					(cause.code === 'ENOENT' || cause.code === 'ESRCH')
				) {
					return undefined;
				}
				throw cause;
			}
		},
		catch: (cause) =>
			new ProcessError({ message: `Could not inspect process ${pid}`, cause }),
	});

const readProcess = (pid: number) =>
	process.platform === 'linux' ? readLinuxProcess(pid) : readMacProcess(pid);

const isSafeProcessId = (value: number) =>
	Number.isSafeInteger(value) && value > 1;

const isGoneCause = (cause: unknown) =>
	cause instanceof Error &&
	'code' in cause &&
	((cause as NodeJS.ErrnoException).code === 'ESRCH' ||
		(cause as NodeJS.ErrnoException).code === 'ENOENT');

const signalGroup = (processGroupId: number, signal: NodeJS.Signals | 0) => {
	if (!isSafeProcessId(processGroupId))
		return Effect.fail(
			new ProcessError({
				message: `Refusing to signal invalid process group ${processGroupId}`,
			}),
		);
	return Effect.try({
		try: () => process.kill(-processGroupId, signal),
		catch: (cause) =>
			new ProcessError({
				message: `Could not signal process group ${processGroupId}`,
				cause,
			}),
	});
};

const readGroupMembers = (processGroupId: number) =>
	Effect.tryPromise({
		try: () =>
			new Promise<boolean>((resolve, reject) => {
				execFile(
					'ps',
					['-g', String(processGroupId), '-o', 'pid='],
					{ timeout: PROCESS_INSPECTION_TIMEOUT_MS },
					(error, stdout) => {
						if (error !== null) {
							const nodeError = error as NodeJS.ErrnoException;
							const exitCode = (
								error as NodeJS.ErrnoException & { code?: string | number }
							).code;
							if (
								nodeError.code === 'ESRCH' ||
								nodeError.code === 'ENOENT' ||
								Number(exitCode) === 1
							) {
								resolve(false);
								return;
							}
							reject(error);
							return;
						}
						resolve(stdout.trim().length > 0);
					},
				);
			}),
		catch: (cause) =>
			new ProcessError({
				message: `Could not inspect process group ${processGroupId}`,
				cause,
			}),
	});

type GroupLivenessFallback = {
	readonly alive: boolean;
	readonly expiresAt: number;
	readonly delayMs: number;
};

const groupIsAlive = (
	processGroupId: number,
	fallbacks: Map<number, GroupLivenessFallback>,
) =>
	!isSafeProcessId(processGroupId)
		? Effect.succeed(false)
		: signalGroup(processGroupId, 0).pipe(
				Effect.tap(() =>
					Effect.sync(() => {
						fallbacks.delete(processGroupId);
					}),
				),
				Effect.as(true),
				Effect.catchTag('ProcessError', (error) =>
					Effect.gen(function* () {
						if (isGoneCause(error.cause)) {
							fallbacks.delete(processGroupId);
							return false;
						}
						if (!(error.cause instanceof Error)) return yield* error;
						const code = (error.cause as NodeJS.ErrnoException).code;
						if (code !== 'EPERM') return yield* error;
						const cached = fallbacks.get(processGroupId);
						if (cached !== undefined && cached.expiresAt > Date.now())
							return cached.alive;
						return yield* readGroupMembers(processGroupId).pipe(
							Effect.tap((alive) =>
								Effect.sync(() => {
									const previous = fallbacks.get(processGroupId);
									const delayMs =
										previous === undefined
											? GROUP_LIVENESS_BACKOFF_INITIAL_MS
											: Math.min(
													previous.delayMs * 2,
													GROUP_LIVENESS_BACKOFF_MAX_MS,
												);
									fallbacks.set(processGroupId, {
										alive,
										expiresAt: Date.now() + delayMs,
										delayMs,
									});
								}),
							),
						);
					}),
				),
			);

const isValidIdentity = (identity: ProcessIdentity) =>
	isSafeProcessId(identity.pid) && isSafeProcessId(identity.processGroupId);

const invalidIdentity = (identity: ProcessIdentity) =>
	new ProcessError({
		message: `Refusing to use invalid process identity ${identity.pid}/${identity.processGroupId}`,
	});

const waitForGroupExit = (
	groupAlive: (processGroupId: number) => Effect.Effect<boolean, ProcessError>,
	processGroupId: number,
	remaining: number,
): Effect.Effect<boolean, ProcessError> =>
	groupAlive(processGroupId).pipe(
		Effect.flatMap((alive) => {
			if (!alive) return Effect.succeed(true);
			if (remaining <= 0) return Effect.succeed(false);
			return Effect.sleep(`${TERMINATION_POLL_INTERVAL_MS} millis`).pipe(
				Effect.andThen(
					waitForGroupExit(groupAlive, processGroupId, remaining - 1),
				),
			);
		}),
	);

export class Processes extends Context.Service<Processes>()(
	'devsess/cli/Processes',
	{
		make: Effect.gen(function* () {
			const livenessFallbacks = new Map<number, GroupLivenessFallback>();
			const inspect = (pid: number) => readProcess(pid);
			const groupAlive = (processGroupId: number) =>
				groupIsAlive(processGroupId, livenessFallbacks);
			const capture = (pid: number) =>
				!isSafeProcessId(pid)
					? Effect.fail(
							new ProcessError({
								message: `Refusing to inspect invalid process ${pid}`,
							}),
						)
					: inspect(pid).pipe(
							Effect.flatMap((process) => {
								if (process === undefined) {
									return new ProcessError({
										message: `Process ${pid} exited before ownership could be recorded`,
									});
								}
								return Effect.succeed({
									pid,
									processGroupId: process.processGroupId,
									startedAt: process.startedAt,
								});
							}),
						);
			const owns = (identity: ProcessIdentity) =>
				!isValidIdentity(identity)
					? Effect.succeed(false)
					: inspect(identity.pid).pipe(
							Effect.flatMap((process) => {
								if (process === undefined) return Effect.succeed(false);
								return Effect.succeed(
									process.processGroupId === identity.processGroupId &&
										process.startedAt === identity.startedAt,
								);
							}),
						);
			const terminate = (
				identity: ProcessIdentity,
				force: boolean,
			): Effect.Effect<number | undefined, ProcessError> =>
				Effect.gen(function* () {
					if (!isValidIdentity(identity))
						return yield* invalidIdentity(identity);
					if (!force && !(yield* owns(identity))) {
						if (yield* groupAlive(identity.processGroupId))
							return yield* new ProcessError({
								message: `Cannot verify recovered process group ${identity.processGroupId} after its leader exited`,
							});
						return;
					}
					let termSent = true;
					yield* signalGroup(identity.processGroupId, 'SIGTERM').pipe(
						Effect.catchTag('ProcessError', (error) =>
							isGoneCause(error.cause)
								? Effect.sync(() => {
										termSent = false;
									})
								: error,
						),
					);
					if (
						yield* waitForGroupExit(
							groupAlive,
							identity.processGroupId,
							TERMINATION_POLL_ATTEMPTS,
						)
					)
						return termSent ? TERMINATION_TERM_SIGNAL : undefined;
					if (!force && !(yield* owns(identity)))
						return yield* new ProcessError({
							message: `Cannot safely escalate recovered process group ${identity.processGroupId} after its leader changed`,
						});
					let killSent = true;
					yield* signalGroup(identity.processGroupId, 'SIGKILL').pipe(
						Effect.catchTag('ProcessError', (error) =>
							isGoneCause(error.cause)
								? Effect.sync(() => {
										killSent = false;
									})
								: error,
						),
					);
					if (
						!(yield* waitForGroupExit(
							groupAlive,
							identity.processGroupId,
							TERMINATION_POLL_ATTEMPTS,
						))
					)
						return yield* new ProcessError({
							message: `Process group ${identity.processGroupId} survived SIGKILL`,
						});
					return killSent ? TERMINATION_KILL_SIGNAL : undefined;
				});
			const captureLive = (
				pid: number,
			): Effect.Effect<LiveProcessOwnership, ProcessError> =>
				Effect.gen(function* () {
					const identity = yield* capture(pid);
					if (identity.processGroupId !== pid)
						return yield* new ProcessError({
							message: `Process ${pid} is not its own group leader`,
						});
					const permit = yield* Semaphore.make(1);
					let valid = true;
					const signal = (value: NodeJS.Signals | 0) =>
						Effect.suspend(() => {
							if (!valid) return Effect.succeed(false);
							if (value === 0)
								return groupAlive(identity.processGroupId).pipe(
									Effect.tap((alive) =>
										Effect.sync(() => {
											if (!alive) valid = false;
										}),
									),
								);
							return signalGroup(identity.processGroupId, value).pipe(
								Effect.as(true),
								Effect.catch((error) => {
									if (isGoneCause(error.cause)) {
										valid = false;
										return Effect.succeed(false);
									}
									return error;
								}),
							);
						});
					const wait = (
						attempts: number,
					): Effect.Effect<boolean, ProcessError> =>
						Effect.gen(function* () {
							if (!(yield* signal(0))) return true;
							if (attempts === 0) return false;
							yield* Effect.sleep(`${TERMINATION_POLL_INTERVAL_MS} millis`);
							return yield* wait(attempts - 1);
						});
					/** Only newly owned PTYs get this capability; never reconstruct it from saved PIDs.
					 * Unix group IDs have a disappearance/reuse race between observations, so use it
					 * immediately on leader exit and invalidate it permanently on observed disappearance. */
					const terminate = permit.withPermit(
						Effect.gen(function* () {
							if (!(yield* signal('SIGTERM'))) return undefined;
							if (yield* wait(TERMINATION_POLL_ATTEMPTS))
								return TERMINATION_TERM_SIGNAL;
							if (!(yield* signal('SIGKILL'))) return undefined;
							if (yield* wait(TERMINATION_POLL_ATTEMPTS))
								return TERMINATION_KILL_SIGNAL;
							return yield* new ProcessError({
								message: `Process group ${identity.processGroupId} survived SIGKILL`,
							});
						}),
					);
					return { identity, terminate } satisfies LiveProcessOwnership;
				});
			return { capture, captureLive, owns, groupAlive, terminate };
		}),
	},
) {
	static readonly layer = Layer.effect(Processes, Processes.make);
}
