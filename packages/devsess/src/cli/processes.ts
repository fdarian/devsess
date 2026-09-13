import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { Context, Effect, Layer, Schema, Semaphore } from 'effect';

export type ProcessIdentity = {
	readonly pid: number;
	readonly processGroupId: number;
	/** Process birth fingerprint. Linux uses `/proc` clock ticks; macOS falls back to `ps lstart` seconds. */
	readonly startedAt: string;
};

export type LiveProcessOwnership = {
	readonly identity: ProcessIdentity;
	readonly terminate: Effect.Effect<void, ProcessError>;
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
						if (!Number.isSafeInteger(processGroupId) || processGroupId <= 0) {
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
				if (
					!Number.isSafeInteger(processGroupId) ||
					processGroupId <= 0 ||
					startTicks === undefined
				) {
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

const signalGroup = (processGroupId: number, signal: NodeJS.Signals | 0) =>
	Effect.try({
		try: () => process.kill(-processGroupId, signal),
		catch: (cause) =>
			new ProcessError({
				message: `Could not signal process group ${processGroupId}`,
				cause,
			}),
	});

const groupIsAlive = (processGroupId: number) =>
	signalGroup(processGroupId, 0).pipe(
		Effect.as(true),
		Effect.catchTag('ProcessError', (error) =>
			error.cause instanceof Error &&
			((error.cause as NodeJS.ErrnoException).code === 'ESRCH' ||
				(error.cause as NodeJS.ErrnoException).code === 'ENOENT')
				? Effect.succeed(false)
				: error,
		),
	);

export class Processes extends Context.Service<Processes>()(
	'devsess/cli/Processes',
	{
		make: Effect.gen(function* () {
			const inspect = (pid: number) => readProcess(pid);
			const groupAlive = (processGroupId: number) =>
				groupIsAlive(processGroupId);
			const capture = (pid: number) =>
				inspect(pid).pipe(
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
				inspect(identity.pid).pipe(
					Effect.flatMap((process) => {
						if (process === undefined) return Effect.succeed(false);
						return Effect.succeed(
							process.processGroupId === identity.processGroupId &&
								process.startedAt === identity.startedAt,
						);
					}),
				);
			const ownsProcessOrGroup = (identity: ProcessIdentity) =>
				inspect(identity.pid).pipe(
					Effect.flatMap((process) =>
						process === undefined
							? groupAlive(identity.processGroupId)
							: Effect.succeed(
									process.processGroupId === identity.processGroupId &&
										process.startedAt === identity.startedAt,
								),
					),
				);
			const waitForExit = (
				identity: ProcessIdentity,
				remaining: number,
			): Effect.Effect<void, ProcessError> =>
				ownsProcessOrGroup(identity).pipe(
					Effect.flatMap((isOwned) => {
						if (!isOwned || remaining <= 0) return Effect.void;
						return Effect.sleep('25 millis').pipe(
							Effect.andThen(waitForExit(identity, remaining - 1)),
						);
					}),
				);
			const terminate = (identity: ProcessIdentity) =>
				ownsProcessOrGroup(identity).pipe(
					Effect.flatMap((isOwned) => {
						if (!isOwned) return Effect.void;
						return signalGroup(identity.processGroupId, 'SIGTERM').pipe(
							Effect.catchTag('ProcessError', (error) =>
								error.cause instanceof Error &&
								(error.cause as NodeJS.ErrnoException).code === 'ESRCH'
									? Effect.void
									: error,
							),
							Effect.andThen(waitForExit(identity, 200)),
							Effect.andThen(
								ownsProcessOrGroup(identity).pipe(
									Effect.flatMap((stillOwned) =>
										stillOwned
											? signalGroup(identity.processGroupId, 'SIGKILL').pipe(
													Effect.catchTag('ProcessError', (error) =>
														error.cause instanceof Error &&
														(error.cause as NodeJS.ErrnoException).code ===
															'ESRCH'
															? Effect.void
															: error,
													),
												)
											: Effect.void,
									),
								),
							),
						);
					}),
				);
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
							return signalGroup(identity.processGroupId, value).pipe(
								Effect.as(true),
								Effect.catch((error) => {
									if (
										error.cause instanceof Error &&
										(error.cause as NodeJS.ErrnoException).code === 'ESRCH'
									) {
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
							yield* Effect.sleep('25 millis');
							return yield* wait(attempts - 1);
						});
					/** Only newly owned PTYs get this capability; never reconstruct it from saved PIDs.
					 * Unix group IDs have a disappearance/reuse race between observations, so use it
					 * immediately on leader exit and invalidate it permanently on observed disappearance. */
					const terminate = permit.withPermit(
						Effect.gen(function* () {
							if (!(yield* signal('SIGTERM'))) return;
							if (yield* wait(200)) return;
							if (!(yield* signal('SIGKILL'))) return;
							if (!(yield* wait(200)))
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
