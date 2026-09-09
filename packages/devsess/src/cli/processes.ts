import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { Context, Effect, Layer, Schema } from 'effect';

export type ProcessIdentity = {
	readonly pid: number;
	readonly processGroupId: number;
	/** Process birth fingerprint. Linux uses `/proc` clock ticks; macOS falls back to `ps lstart` seconds. */
	readonly startedAt: string;
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
							if (nodeError.code === 'ESRCH' || nodeError.code === 'ENOENT') {
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
			(error.cause as NodeJS.ErrnoException).code === 'ESRCH'
				? Effect.succeed(false)
				: error,
		),
	);

export class Processes extends Context.Service<Processes>()(
	'devsess/cli/Processes',
	{
		make: Effect.gen(function* () {
			const inspect = (pid: number) => readProcess(pid);
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
						if (process === undefined)
							return groupIsAlive(identity.processGroupId);
						return Effect.succeed(
							process.processGroupId === identity.processGroupId &&
								process.startedAt === identity.startedAt,
						);
					}),
				);
			const waitForExit = (
				identity: ProcessIdentity,
				remaining: number,
			): Effect.Effect<void, ProcessError> =>
				owns(identity).pipe(
					Effect.flatMap((isOwned) => {
						if (!isOwned || remaining <= 0) return Effect.void;
						return Effect.sleep('25 millis').pipe(
							Effect.andThen(waitForExit(identity, remaining - 1)),
						);
					}),
				);
			const terminate = (identity: ProcessIdentity) =>
				owns(identity).pipe(
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
								owns(identity).pipe(
									Effect.flatMap((stillOwned) =>
										stillOwned
											? signalGroup(identity.processGroupId, 'SIGKILL')
											: Effect.void,
									),
								),
							),
						);
					}),
				);
			return { capture, owns, terminate };
		}),
	},
) {
	static readonly layer = Layer.effect(Processes, Processes.make);
}
