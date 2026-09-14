import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import {
	Context,
	Deferred,
	Effect,
	Exit,
	Layer,
	Schema,
	Semaphore,
} from 'effect';
import {
	GROUP_LIVENESS_BACKOFF_INITIAL_MS,
	GROUP_LIVENESS_BACKOFF_MAX_MS,
	PROCESS_INSPECTION_TIMEOUT_MS,
	TERMINATION_KILL_SIGNAL,
	TERMINATION_PHASE_TIMEOUT_MS,
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
	alive: boolean | undefined;
	nextCheckAt: number;
	delayMs: number;
	inFlight: Deferred.Deferred<boolean, ProcessError> | undefined;
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
						if (cached?.inFlight !== undefined)
							return yield* Deferred.await(cached.inFlight);
						if (cached?.alive !== undefined && cached.nextCheckAt > Date.now())
							return cached.alive;
						const state: GroupLivenessFallback = cached ?? {
							alive: undefined,
							nextCheckAt: 0,
							delayMs: GROUP_LIVENESS_BACKOFF_INITIAL_MS,
							inFlight: undefined,
						};
						const pending = yield* Deferred.make<boolean, ProcessError>();
						state.inFlight = pending;
						fallbacks.set(processGroupId, state);
						const result = yield* Effect.exit(readGroupMembers(processGroupId));
						state.inFlight = undefined;
						if (Exit.isSuccess(result)) {
							const checkedAt = Date.now();
							if (fallbacks.get(processGroupId) === state) {
								state.delayMs = Math.min(
									state.delayMs * 2,
									GROUP_LIVENESS_BACKOFF_MAX_MS,
								);
								state.alive = result.value;
								state.nextCheckAt =
									checkedAt +
									Math.max(state.delayMs, PROCESS_INSPECTION_TIMEOUT_MS);
							}
							yield* Deferred.succeed(pending, result.value);
						} else {
							if (fallbacks.get(processGroupId) === state)
								state.nextCheckAt = Date.now() + PROCESS_INSPECTION_TIMEOUT_MS;
							yield* Deferred.failCause(pending, result.cause);
						}
						if (Exit.isSuccess(result)) return result.value;
						return yield* Effect.failCause(result.cause);
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
	deadline: number,
): Effect.Effect<boolean, ProcessError> =>
	Effect.gen(function* () {
		const remaining = deadline - Date.now();
		if (remaining <= 0) return false;
		const alive = yield* groupAlive(processGroupId).pipe(
			Effect.timeoutOrElse({
				duration: `${remaining} millis`,
				orElse: () => Effect.succeed(undefined),
			}),
		);
		if (alive === undefined) return false;
		if (!alive) return true;
		const sleep = Math.min(TERMINATION_POLL_INTERVAL_MS, deadline - Date.now());
		if (sleep <= 0) return false;
		yield* Effect.sleep(`${sleep} millis`);
		return yield* waitForGroupExit(groupAlive, processGroupId, deadline);
	});

type TerminationHooks = {
	readonly processGroupId: number;
	readonly groupAlive: (
		processGroupId: number,
	) => Effect.Effect<boolean, ProcessError>;
	readonly signal: (
		signal: NodeJS.Signals,
	) => Effect.Effect<boolean, ProcessError>;
	readonly canEscalate: Effect.Effect<boolean, ProcessError>;
};

const terminateWithEscalation = (
	hooks: TerminationHooks,
): Effect.Effect<number | undefined, ProcessError> =>
	Effect.gen(function* () {
		const termSent = yield* hooks.signal('SIGTERM');
		if (!termSent) return undefined;
		const termDeadline = Date.now() + TERMINATION_PHASE_TIMEOUT_MS;
		if (
			yield* waitForGroupExit(
				hooks.groupAlive,
				hooks.processGroupId,
				termDeadline,
			)
		)
			return TERMINATION_TERM_SIGNAL;
		if (!(yield* hooks.canEscalate)) return undefined;
		const killSent = yield* hooks.signal('SIGKILL');
		if (!killSent) return undefined;
		const killDeadline = Date.now() + TERMINATION_PHASE_TIMEOUT_MS;
		if (
			!(yield* waitForGroupExit(
				hooks.groupAlive,
				hooks.processGroupId,
				killDeadline,
			))
		)
			return yield* new ProcessError({
				message: `Process group ${hooks.processGroupId} survived SIGKILL`,
			});
		return TERMINATION_KILL_SIGNAL;
	});

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
					const signal = (value: NodeJS.Signals) =>
						signalGroup(identity.processGroupId, value).pipe(
							Effect.as(true),
							Effect.catchTag('ProcessError', (error) =>
								isGoneCause(error.cause) ? Effect.succeed(false) : error,
							),
						);
					const canEscalate = force
						? Effect.succeed(true)
						: owns(identity).pipe(
								Effect.flatMap((owned) =>
									owned
										? Effect.succeed(true)
										: new ProcessError({
												message: `Cannot safely escalate recovered process group ${identity.processGroupId} after its leader changed`,
											}),
								),
							);
					return yield* terminateWithEscalation({
						processGroupId: identity.processGroupId,
						groupAlive,
						signal,
						canEscalate,
					});
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
					const liveGroupAlive = (processGroupId: number) =>
						groupAlive(processGroupId).pipe(
							Effect.tap((alive) =>
								Effect.sync(() => {
									if (!alive) valid = false;
								}),
							),
						);
					/** Only newly owned PTYs get this capability; never reconstruct it from saved PIDs.
					 * Unix group IDs have a disappearance/reuse race between observations, so use it
					 * immediately on leader exit and invalidate it permanently on observed disappearance. */
					const terminate = permit.withPermit(
						terminateWithEscalation({
							processGroupId: identity.processGroupId,
							groupAlive: liveGroupAlive,
							signal,
							canEscalate: Effect.succeed(true),
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

export type ProcessesService = Context.Service.Shape<typeof Processes>;
