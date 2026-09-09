import { execFile, spawn } from 'node:child_process';
import {
	lstatSync,
	mkdirSync,
	readFileSync,
	renameSync,
	rmSync,
	unlinkSync,
	writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { Effect, Schedule, Schema } from 'effect';
import { callDaemon } from './client';

export class DaemonBootstrapError extends Schema.TaggedErrorClass<DaemonBootstrapError>()(
	'DaemonBootstrapError',
	{
		message: Schema.String,
		cause: Schema.optional(Schema.Defect()),
	},
) {}

export const awaitDaemonHandshake = (options: {
	socketPath: string;
	timeoutMs: number;
}) =>
	callDaemon(
		options.socketPath,
		{
			version: 1,
			requestId: crypto.randomUUID(),
			method: 'listRuns',
			params: {},
		},
		Math.min(options.timeoutMs, 250),
	).pipe(
		Effect.retry({
			schedule: Schedule.spaced('25 millis'),
			times: Math.ceil(options.timeoutMs / 25),
		}),
		Effect.asVoid,
		Effect.mapError(
			(cause) =>
				new DaemonBootstrapError({
					message: `Could not complete daemon handshake at ${options.socketPath}`,
					cause,
				}),
		),
	);

export const launchDetachedDaemon = (options: {
	command: string;
	args: Array<string>;
}) =>
	Effect.try({
		try: () => {
			const child = spawn(options.command, options.args, {
				detached: true,
				stdio: 'ignore',
			});
			child.unref();
			if (child.pid === undefined) {
				throw new Error(
					`Detached daemon ${options.command} did not receive a PID`,
				);
			}
			return child.pid;
		},
		catch: (cause) =>
			new DaemonBootstrapError({
				message: `Could not launch detached daemon ${options.command}`,
				cause,
			}),
	});

type DaemonLocation = {
	dataDirectory: string;
	socketPath: string;
};

type LaunchDaemon = () => Effect.Effect<unknown, DaemonBootstrapError>;

const lockDirectory = (location: DaemonLocation) =>
	join(location.dataDirectory, 'daemon-launch.lock');
const ownerPath = (location: DaemonLocation) =>
	join(lockDirectory(location), 'owner');

/** Linux exposes a process birth value that lets a stale lock distinguish PID reuse. */
const processBirth = (pid: number) =>
	Effect.tryPromise({
		try: async () => {
			if (process.platform === 'linux') {
				const stat = await import('node:fs/promises')
					.then((fs) => fs.readFile(`/proc/${pid}/stat`, 'utf8'))
					.catch((cause) => {
						if (
							cause instanceof Error &&
							'code' in cause &&
							cause.code === 'ENOENT'
						)
							return undefined;
						throw cause;
					});
				if (stat === undefined) return undefined;
				const fields = stat
					.slice(stat.lastIndexOf(')') + 2)
					.trim()
					.split(/\s+/);
				const startedAt = fields[19];
				if (startedAt === undefined)
					throw new Error(`PID ${pid} has no birth value`);
				return `linux:${startedAt}`;
			}
			return await new Promise<string | undefined>((resolve, reject) => {
				execFile(
					'ps',
					['-o', 'lstart=', '-p', String(pid)],
					(error, stdout) => {
						if (error !== null && 'code' in error && Number(error.code) === 1) {
							resolve(undefined);
							return;
						}
						if (error !== null) {
							reject(error);
							return;
						}
						const startedAt = stdout.trim();
						if (startedAt.length === 0) {
							reject(new Error(`PID ${pid} has no birth value`));
							return;
						}
						resolve(`ps:${startedAt}`);
					},
				);
			});
		},
		catch: (cause) =>
			new DaemonBootstrapError({
				message: `Could not inspect process birth for PID ${pid}`,
				cause,
			}),
	});

const owner = (location: DaemonLocation) =>
	Effect.try({
		try: () => {
			try {
				const lines = readFileSync(ownerPath(location), 'utf8').split('\n');
				const pid = Number(lines[0]);
				const startedAt = lines[1];
				const token = lines[2];
				if (
					!Number.isSafeInteger(pid) ||
					pid <= 0 ||
					startedAt === undefined ||
					startedAt.length === 0 ||
					token === undefined ||
					token.length === 0
				)
					return undefined;
				return { pid, startedAt, token };
			} catch (cause) {
				if (
					cause instanceof Error &&
					'code' in cause &&
					cause.code === 'ENOENT'
				)
					return undefined;
				throw cause;
			}
		},
		catch: (cause) =>
			new DaemonBootstrapError({
				message: `Could not read daemon launch owner at ${ownerPath(location)}`,
				cause,
			}),
	});

const ownsLock = (value: { pid: number; startedAt: string }) =>
	processBirth(value.pid).pipe(
		Effect.map((startedAt) => startedAt === value.startedAt),
	);

const createDirectories = (location: DaemonLocation) =>
	Effect.try({
		try: () => {
			const ensurePrivateDirectory = (path: string) => {
				mkdirSync(path, { recursive: true, mode: 0o700 });
				const stat = lstatSync(path);
				const uid = process.getuid?.();
				if (
					!stat.isDirectory() ||
					stat.isSymbolicLink() ||
					(uid !== undefined && stat.uid !== uid) ||
					(stat.mode & 0o077) !== 0
				)
					throw new Error(
						`Daemon directory ${path} must be private and user-owned`,
					);
			};
			ensurePrivateDirectory(location.dataDirectory);
			ensurePrivateDirectory(dirname(location.socketPath));
		},
		catch: (cause) =>
			new DaemonBootstrapError({
				message: `Could not create daemon directories for ${location.socketPath}`,
				cause,
			}),
	});

const removeStaleLock = (location: DaemonLocation) =>
	Effect.try({
		try: () => {
			const stale = `${lockDirectory(location)}.stale-${crypto.randomUUID()}`;
			try {
				renameSync(lockDirectory(location), stale);
			} catch (cause) {
				if (
					cause instanceof Error &&
					'code' in cause &&
					cause.code === 'ENOENT'
				)
					return false;
				throw cause;
			}
			rmSync(stale, { recursive: true, force: true });
			return true;
		},
		catch: (cause) =>
			new DaemonBootstrapError({
				message: `Could not recover stale daemon launch lock at ${lockDirectory(location)}`,
				cause,
			}),
	});

const removeStaleSocket = (socketPath: string) =>
	Effect.try({
		try: () => {
			try {
				unlinkSync(socketPath);
			} catch (cause) {
				if (
					cause instanceof Error &&
					'code' in cause &&
					cause.code === 'ENOENT'
				)
					return;
				throw cause;
			}
		},
		catch: (cause) =>
			new DaemonBootstrapError({
				message: `Could not remove stale daemon socket at ${socketPath}`,
				cause,
			}),
	});

const waitForDaemon = (
	location: DaemonLocation,
	remaining: number,
): Effect.Effect<void, DaemonBootstrapError> =>
	awaitDaemonHandshake({
		socketPath: location.socketPath,
		timeoutMs: 100,
	}).pipe(
		Effect.catch(() => {
			if (remaining <= 0)
				return new DaemonBootstrapError({
					message: `Timed out waiting for the daemon launch lock at ${lockDirectory(location)}`,
				});
			return Effect.sleep('25 millis').pipe(
				Effect.andThen(waitForDaemon(location, remaining - 1)),
			);
		}),
	);

/** Serializes per-user daemon startup; stale owners are identified by PID and process birth value. */
export const ensureDaemon = (options: {
	location: DaemonLocation;
	launch: LaunchDaemon;
}) => {
	const acquire = (
		missingOwnerAttempts: number,
		waitAttempts: number,
	): Effect.Effect<void, DaemonBootstrapError> =>
		Effect.tryPromise({
			try: () =>
				new Promise<boolean>((resolve, reject) => {
					try {
						mkdirSync(lockDirectory(options.location), { mode: 0o700 });
						resolve(true);
					} catch (cause) {
						if (
							cause instanceof Error &&
							'code' in cause &&
							cause.code === 'EEXIST'
						) {
							resolve(false);
							return;
						}
						reject(cause);
					}
				}),
			catch: (cause) =>
				new DaemonBootstrapError({
					message: `Could not acquire daemon launch lock at ${lockDirectory(options.location)}`,
					cause,
				}),
		}).pipe(
			Effect.flatMap((acquired) => {
				if (acquired) {
					const token = crypto.randomUUID();
					return processBirth(process.pid).pipe(
						Effect.flatMap((startedAt) => {
							if (startedAt === undefined)
								return new DaemonBootstrapError({
									message: `Could not record daemon launch owner for PID ${process.pid}`,
								});
							const content = `${process.pid}\n${startedAt}\n${token}\n`;
							const release = Effect.sync(() => {
								try {
									if (
										readFileSync(ownerPath(options.location), 'utf8') ===
										content
									)
										rmSync(lockDirectory(options.location), {
											recursive: true,
											force: true,
										});
								} catch {}
							});
							return Effect.try({
								try: () =>
									writeFileSync(ownerPath(options.location), content, {
										mode: 0o600,
									}),
								catch: (cause) =>
									new DaemonBootstrapError({
										message: `Could not write daemon launch owner at ${ownerPath(options.location)}`,
										cause,
									}),
							}).pipe(
								Effect.andThen(
									awaitDaemonHandshake({
										socketPath: options.location.socketPath,
										timeoutMs: 150,
									}).pipe(
										Effect.catch(() =>
											removeStaleSocket(options.location.socketPath).pipe(
												Effect.andThen(options.launch()),
												Effect.andThen(
													awaitDaemonHandshake({
														socketPath: options.location.socketPath,
														timeoutMs: 5_000,
													}),
												),
											),
										),
									),
								),
								Effect.ensuring(release),
							);
						}),
					);
				}
				return waitForDaemon(options.location, 1).pipe(
					Effect.catch(() =>
						owner(options.location).pipe(
							Effect.flatMap((current) => {
								if (current === undefined && missingOwnerAttempts < 10)
									return Effect.sleep('25 millis').pipe(
										Effect.andThen(
											acquire(missingOwnerAttempts + 1, waitAttempts + 1),
										),
									);
								if (current === undefined)
									return new DaemonBootstrapError({
										message: `Daemon launch lock at ${lockDirectory(options.location)} has no valid owner`,
									});
								if (waitAttempts >= 200)
									return new DaemonBootstrapError({
										message: `Timed out waiting for daemon launch owner ${current.pid}`,
									});
								return ownsLock(current).pipe(
									Effect.flatMap((live) =>
										live
											? Effect.sleep('25 millis').pipe(
													Effect.andThen(acquire(0, waitAttempts + 1)),
												)
											: removeStaleLock(options.location).pipe(
													Effect.andThen(acquire(0, 0)),
												),
									),
								);
							}),
						),
					),
				);
			}),
		);
	return awaitDaemonHandshake({
		socketPath: options.location.socketPath,
		timeoutMs: 150,
	}).pipe(
		Effect.catch(() =>
			createDirectories(options.location).pipe(Effect.andThen(acquire(0, 0))),
		),
	);
};
