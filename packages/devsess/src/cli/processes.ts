import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import {
	Context,
	Deferred,
	Effect,
	Exit,
	Fiber,
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

type TreeProcess = {
	readonly pid: number;
	readonly parentPid: number;
	readonly processGroupId: number;
	readonly startedAt: string;
};

export const parseProcessTree = (output: string): ReadonlyArray<TreeProcess> =>
	output.split('\n').flatMap((line) => {
		const match = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s+(.{24})\s*$/.exec(line);
		if (match === null) return [];
		const pid = Number(match[1]);
		const parentPid = Number(match[2]);
		const processGroupId = Number(match[3]);
		const status = match[4];
		const startedAt = match[5];
		return isSafeProcessId(pid) &&
			isSafeProcessId(processGroupId) &&
			status !== undefined &&
			!status.startsWith('Z') &&
			startedAt !== undefined
			? [{ pid, parentPid, processGroupId, startedAt: startedAt.trim() }]
			: [];
	});

export const descendantProcesses = (
	tree: ReadonlyArray<TreeProcess>,
	identity: ProcessIdentity,
	trackedPids: ReadonlySet<number> = new Set(),
	trustedGroupPids?: ReadonlySet<number>,
): ReadonlyArray<TreeProcess> => {
	const descendants = new Set(
		trustedGroupPids === undefined
			? tree
					.filter(
						(process) => process.processGroupId === identity.processGroupId,
					)
					.map((process) => process.pid)
			: trustedGroupPids,
	);
	if (trustedGroupPids === undefined) descendants.add(identity.pid);
	for (const pid of trackedPids) descendants.add(pid);
	let changed = true;
	while (changed) {
		changed = false;
		for (const process of tree) {
			if (descendants.has(process.parentPid) && !descendants.has(process.pid)) {
				descendants.add(process.pid);
				changed = true;
			}
		}
	}
	return tree.filter(
		(process) =>
			descendants.has(process.pid) &&
			process.processGroupId !== identity.processGroupId,
	);
};

const readProcessTree = () =>
	Effect.tryPromise({
		try: () =>
			new Promise<ReadonlyArray<TreeProcess>>((resolve, reject) => {
				execFile(
					'ps',
					['-A', '-o', 'pid=,ppid=,pgid=,stat=,lstart='],
					{ timeout: PROCESS_INSPECTION_TIMEOUT_MS },
					(error, stdout) =>
						error === null ? resolve(parseProcessTree(stdout)) : reject(error),
				);
			}),
		catch: (cause) =>
			new ProcessError({ message: 'Could not inspect process tree', cause }),
	});

const readTreeProcess = (pid: number) =>
	Effect.tryPromise({
		try: () =>
			new Promise<TreeProcess | undefined>((resolve, reject) => {
				execFile(
					'ps',
					['-o', 'pid=,ppid=,pgid=,stat=,lstart=', '-p', String(pid)],
					{ timeout: PROCESS_INSPECTION_TIMEOUT_MS },
					(error, stdout) => {
						if (error !== null) {
							const code = (error as NodeJS.ErrnoException).code;
							if (code === 'ESRCH' || code === 'ENOENT' || Number(code) === 1) {
								resolve(undefined);
								return;
							}
							reject(error);
							return;
						}
						resolve(parseProcessTree(stdout)[0]);
					},
				);
			}),
		catch: (cause) =>
			new ProcessError({ message: `Could not inspect process ${pid}`, cause }),
	});

const ownsTreeProcess = (identity: TreeProcess) =>
	readTreeProcess(identity.pid).pipe(
		Effect.map(
			(process) =>
				process !== undefined &&
				process.processGroupId === identity.processGroupId &&
				process.startedAt === identity.startedAt,
		),
	);

export const makeProcessSampler = (
	readTree: () => Effect.Effect<ReadonlyArray<TreeProcess>, ProcessError>,
) => {
	const listeners = new Set<(tree: ReadonlyArray<TreeProcess>) => void>();
	const sample = Effect.suspend(readTree).pipe(
		Effect.tap((tree) =>
			Effect.sync(() => {
				for (const listener of listeners) listener(tree);
			}),
		),
	);
	return {
		sample,
		register: (listener: (tree: ReadonlyArray<TreeProcess>) => void) => {
			listeners.add(listener);
			return () => listeners.delete(listener);
		},
		get size() {
			return listeners.size;
		},
	};
};

const sameTreeProcess = (left: TreeProcess, right: TreeProcess) =>
	left.pid === right.pid &&
	left.processGroupId === right.processGroupId &&
	left.startedAt === right.startedAt;

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
					['-o', 'stat=', '-o', 'pgid=', '-o', 'lstart=', '-p', String(pid)],
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
						const match = /^\s*(\S+)\s+(\d+)\s+(.+?)\s*$/.exec(stdout);
						if (
							match === null ||
							match[1] === undefined ||
							match[2] === undefined ||
							match[3] === undefined
						) {
							resolve(undefined);
							return;
						}
						if (match[1].startsWith('Z')) {
							resolve(undefined);
							return;
						}
						const processGroupId = Number(match[2]);
						if (!isSafeProcessId(processGroupId)) {
							reject(new Error(`Process ${pid} has an invalid process group`));
							return;
						}
						resolve({ processGroupId, startedAt: match[3] });
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
				if (fields[0] === 'Z') return undefined;
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

const signalProcess = (pid: number, signal: NodeJS.Signals) =>
	Effect.try({
		try: () => process.kill(pid, signal),
		catch: (cause) =>
			new ProcessError({ message: `Could not signal process ${pid}`, cause }),
	}).pipe(
		Effect.as(true),
		Effect.catchTag('ProcessError', (error) =>
			isGoneCause(error.cause) ? Effect.succeed(false) : error,
		),
	);

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
			const sampler = makeProcessSampler(readProcessTree);
			let monitor: Fiber.Fiber<void> | undefined;
			const stopMonitor = Effect.gen(function* () {
				const running = monitor;
				monitor = undefined;
				if (running !== undefined) yield* Fiber.interrupt(running);
			});
			const startMonitor = Effect.gen(function* () {
				if (monitor !== undefined) return;
				/** A parent can reparent its children before its exit event reaches us. */
				monitor = yield* Effect.forever(
					Effect.sleep('1 second').pipe(
						Effect.andThen(sampler.sample),
						Effect.catch((error) => Effect.logWarning(error)),
					),
				).pipe(Effect.forkDetach);
			});
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
					const descendants = new Map<number, TreeProcess>();
					const groupMembers = new Map<number, TreeProcess>();
					let initial = true;
					const update = (tree: ReadonlyArray<TreeProcess>) => {
						const leader = tree.find((process) => process.pid === identity.pid);
						const knownLeader = groupMembers.get(identity.pid);
						const leaderOwned =
							leader !== undefined &&
							leader.processGroupId === identity.processGroupId &&
							(initial ||
								(knownLeader !== undefined &&
									sameTreeProcess(knownLeader, leader)));
						const trustedGroupPids = new Set<number>();
						for (const process of tree) {
							if (process.processGroupId !== identity.processGroupId) continue;
							const known = groupMembers.get(process.pid);
							if (
								!leaderOwned &&
								(known === undefined || !sameTreeProcess(known, process))
							)
								continue;
							if (known !== undefined && !sameTreeProcess(known, process))
								continue;
							groupMembers.set(process.pid, process);
							trustedGroupPids.add(process.pid);
						}
						const trackedPids = new Set<number>();
						for (const child of descendants.values())
							if (tree.some((process) => sameTreeProcess(process, child)))
								trackedPids.add(child.pid);
						for (const process of descendantProcesses(
							tree,
							identity,
							trackedPids,
							trustedGroupPids,
						)) {
							const previous = descendants.get(process.pid);
							if (previous !== undefined && !sameTreeProcess(previous, process))
								continue;
							descendants.set(process.pid, process);
						}
						initial = false;
					};
					const unregister = sampler.register(update);
					yield* sampler.sample.pipe(
						Effect.onError(() => Effect.sync(unregister)),
					);
					yield* startMonitor;
					const waitForDescendant = (
						child: TreeProcess,
						deadline: number,
					): Effect.Effect<boolean, ProcessError> =>
						ownsTreeProcess(child).pipe(
							Effect.flatMap((alive) =>
								!alive
									? Effect.succeed(true)
									: Date.now() >= deadline
										? Effect.succeed(false)
										: Effect.sleep(
												`${TERMINATION_POLL_INTERVAL_MS} millis`,
											).pipe(
												Effect.andThen(waitForDescendant(child, deadline)),
											),
							),
						);
					const terminateDescendants = Effect.suspend(() =>
						Effect.forEach(
							[...descendants.values()],
							(child) =>
								Effect.gen(function* () {
									if (!(yield* ownsTreeProcess(child))) return;
									if (!(yield* signalProcess(child.pid, 'SIGTERM'))) return;
									if (
										yield* waitForDescendant(
											child,
											Date.now() + TERMINATION_PHASE_TIMEOUT_MS,
										)
									)
										return;
									if (!(yield* ownsTreeProcess(child))) return;
									yield* signalProcess(child.pid, 'SIGKILL');
									if (
										!(yield* waitForDescendant(
											child,
											Date.now() + TERMINATION_PHASE_TIMEOUT_MS,
										))
									)
										return yield* new ProcessError({
											message: `Descendant process ${child.pid} survived SIGKILL`,
										});
								}),
							{ concurrency: 'unbounded', discard: true },
						),
					);
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
							return Effect.gen(function* () {
								const verified = yield* Effect.forEach(
									[...groupMembers.values()],
									ownsTreeProcess,
								);
								if (!verified.some(Boolean)) {
									if (!(yield* groupAlive(identity.processGroupId))) {
										valid = false;
										return false;
									}
									return yield* new ProcessError({
										message: `Cannot verify process group ${identity.processGroupId} before signaling`,
									});
								}
								return yield* signalGroup(identity.processGroupId, value).pipe(
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
						Effect.gen(function* () {
							const observed = yield* Effect.exit(sampler.sample);
							const group = yield* Effect.exit(
								terminateWithEscalation({
									processGroupId: identity.processGroupId,
									groupAlive: liveGroupAlive,
									signal,
									canEscalate: Effect.succeed(true),
								}),
							);
							yield* terminateDescendants;
							if (Exit.isFailure(observed))
								return yield* Effect.failCause(observed.cause);
							if (Exit.isFailure(group))
								return yield* Effect.failCause(group.cause);
							return group.value;
						}).pipe(
							Effect.ensuring(
								Effect.sync(unregister).pipe(
									Effect.andThen(
										Effect.suspend(() =>
											sampler.size === 0 ? stopMonitor : Effect.void,
										),
									),
								),
							),
						),
					);
					return { identity, terminate } satisfies LiveProcessOwnership;
				});
			return {
				capture,
				captureLive,
				owns,
				groupAlive,
				terminate,
				stopSampler: stopMonitor,
			};
		}),
	},
) {
	static readonly layer = Layer.effect(
		Processes,
		Effect.gen(function* () {
			const processes = yield* Processes.make;
			yield* Effect.addFinalizer(() => processes.stopSampler);
			return processes;
		}),
	);
}

export type ProcessesService = Context.Service.Shape<typeof Processes>;
