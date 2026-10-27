import { execFile } from 'node:child_process';
import { Cause, Effect, Exit, Runtime, Schema } from 'effect';
import { Command, Flag } from 'effect/cli';
import { FileSystem } from 'effect/FileSystem';
import devsessPackageJson from '../../../package.json' with { type: 'json' };
import {
	type DaemonBootstrapError,
	liveDaemonPid,
	removeStalePidfile,
	removeStaleSocket,
} from '../bootstrap';
import { callDaemon, DaemonClientError } from '../client';
import { SHUTDOWN_RUN_STOP_TIMEOUT_MS } from '../daemon';
import {
	type DaemonTerminationError,
	PROCESS_TERM_TIMEOUT_MS,
	terminateProcess,
	waitForProcessExit as waitForProcessExitShared,
} from '../daemon-termination';
import {
	bootoutDaemonJob,
	DAEMON_LAUNCHD_LABEL,
	inspectDaemonJob,
	installDaemonJob,
	removeDaemonJobPlist,
	usesLaunchd,
} from '../launchd';
import { Processes } from '../processes';
import type { DaemonInfo, DaemonRequest } from '../protocol';
import { DaemonInfo as DaemonInfoSchema, PROTOCOL_VERSION } from '../protocol';
import type { RunRecord } from '../registry';
import { selfScriptPath } from '../self-invocation';
import {
	DEFAULT_DAEMON_REQUEST_TIMEOUT_MS,
	PROCESS_INSPECTION_TIMEOUT_MS,
	TERMINATION_KILL_SIGNAL,
} from '../termination';
import {
	CommandError,
	daemonJob,
	decodeRunListResponse,
	ensureDaemon as ensureDaemonCommand,
	isRunActive,
	requestId,
	resolveDaemonLocation,
	write,
} from './daemon';

/** The daemon unlinks its socket first and then spends up to its shutdown budget stopping services, so both waits get that budget plus a margin. */
const DAEMON_STOP_TIMEOUT_MS = SHUTDOWN_RUN_STOP_TIMEOUT_MS + 2_000;
const DAEMON_POLL_INTERVAL_MS = 50;

export class DaemonStatusError extends Schema.TaggedError<DaemonStatusError>()(
	'DaemonStatusError',
	{ message: Schema.String },
) {
	override readonly [Runtime.errorExitCode] = 3;
	override readonly [Runtime.errorReported] = false;
}

type DaemonProbe =
	| { readonly _tag: 'not-running' }
	| { readonly _tag: 'connect-failed'; readonly message: string }
	| { readonly _tag: 'unresponsive'; readonly pid: number | undefined }
	| { readonly _tag: 'running'; readonly info: DaemonInfo }
	| {
			readonly _tag: 'outdated';
			readonly runs: ReadonlyArray<RunRecord>;
	  };

const infoRequest = (): Extract<DaemonRequest, { method: 'info' }> => ({
	version: PROTOCOL_VERSION as 1,
	requestId: requestId(),
	method: 'info' as const,
	params: {},
});

const listRunsRequest = (): Extract<DaemonRequest, { method: 'listRuns' }> => ({
	version: PROTOCOL_VERSION as 1,
	requestId: requestId(),
	method: 'listRuns' as const,
	params: {},
});

const shutdownRequest = (
	force: boolean,
): Extract<DaemonRequest, { method: 'shutdown' }> => ({
	version: PROTOCOL_VERSION as 1,
	requestId: requestId(),
	method: 'shutdown' as const,
	params: force ? { force: true } : {},
});

const decodeInfo = (value: unknown) =>
	Schema.decodeUnknownEffect(DaemonInfoSchema)(value).pipe(
		Effect.mapError(
			(cause) =>
				new CommandError({
					message: 'Daemon returned an invalid info response',
					cause,
				}),
		),
	);

const readInfo = (socketPath: string) =>
	callDaemon(socketPath, infoRequest()).pipe(Effect.flatMap(decodeInfo));

const readRuns = (socketPath: string, timeoutMs?: number) =>
	callDaemon(socketPath, listRunsRequest(), timeoutMs).pipe(
		Effect.flatMap(decodeRunListResponse),
	);

const readSocketOwnerPid = (socketPath: string) =>
	Effect.tryPromise({
		try: () =>
			new Promise<number>((resolve, reject) => {
				execFile(
					'lsof',
					['-nP', '-U', '-F', 'pn'],
					{ timeout: PROCESS_INSPECTION_TIMEOUT_MS },
					(error, stdout) => {
						const ownerPids = new Set<number>();
						let currentPid: number | undefined;
						for (const line of stdout.split('\n')) {
							if (line.startsWith('p')) {
								const pid = Number(line.slice(1));
								currentPid =
									Number.isSafeInteger(pid) && pid > 1 ? pid : undefined;
								continue;
							}
							if (
								!line.startsWith('n') ||
								line.slice(1) !== socketPath ||
								currentPid === undefined
							)
								continue;
							ownerPids.add(currentPid);
						}
						if (ownerPids.size === 1) {
							const ownerPid = Array.from(ownerPids)[0];
							if (ownerPid !== undefined) {
								resolve(ownerPid);
								return;
							}
						}
						if (ownerPids.size > 1) {
							reject(
								new Error(
									`Multiple processes own daemon socket ${socketPath}: ${Array.from(ownerPids).join(', ')}`,
								),
							);
							return;
						}
						if (error !== null) {
							reject(error);
							return;
						}
						reject(new Error(`No process owns daemon socket ${socketPath}`));
					},
				);
			}),
		catch: (cause) =>
			new CommandError({
				message: `Could not identify the process owning daemon socket ${socketPath}`,
				cause,
			}),
	});

const socketExists = (socketPath: string) =>
	Effect.gen(function* () {
		const fileSystem = yield* FileSystem;
		return yield* fileSystem.exists(socketPath).pipe(
			Effect.mapError(
				(cause) =>
					new CommandError({
						message: `Could not inspect daemon socket ${socketPath}`,
						cause,
					}),
			),
		);
	});

const probeDaemon = (
	socketPath: string,
): Effect.Effect<DaemonProbe, unknown, FileSystem> =>
	Effect.gen(function* () {
		if (!(yield* socketExists(socketPath))) {
			// A daemon whose socket was unlinked is still running, just unreachable.
			const pid = yield* liveDaemonPid(socketPath);
			return pid === undefined
				? ({ _tag: 'not-running' } as const)
				: ({ _tag: 'unresponsive', pid } as const);
		}
		const info = yield* Effect.exit(readInfo(socketPath));
		if (Exit.isSuccess(info))
			return { _tag: 'running', info: info.value } as const;
		const error = Cause.squash(info.cause);
		if (error instanceof DaemonClientError && error.kind === 'connect-failed')
			return { _tag: 'connect-failed', message: error.message } as const;
		if (error instanceof DaemonClientError && error.kind === 'rejected') {
			const runs = yield* Effect.exit(readRuns(socketPath));
			if (Exit.isSuccess(runs))
				return { _tag: 'outdated', runs: runs.value } as const;
		}
		return {
			_tag: 'unresponsive',
			pid: yield* liveDaemonPid(socketPath),
		} as const;
	});

const uptime = (startedAt: string) => {
	const timestamp = Date.parse(startedAt);
	if (!Number.isFinite(timestamp))
		return Effect.fail(
			new CommandError({
				message: `Daemon returned an invalid start time: ${startedAt}`,
			}),
		);
	const elapsed = Math.max(0, Date.now() - timestamp);
	const totalSeconds = Math.floor(elapsed / 1000);
	const seconds = totalSeconds % 60;
	const totalMinutes = Math.floor(totalSeconds / 60);
	const minutes = totalMinutes % 60;
	const hours = Math.floor(totalMinutes / 60);
	return Effect.succeed(
		hours > 0
			? `${hours}h ${minutes}m ${seconds}s`
			: minutes > 0
				? `${minutes}m ${seconds}s`
				: `${seconds}s`,
	);
};

const currentScriptPath = () => {
	const scriptPath = selfScriptPath();
	return scriptPath === undefined
		? Effect.fail(
				new CommandError({
					message: 'Could not determine the current CLI script path',
				}),
			)
		: Effect.succeed(scriptPath);
};

const infoLines = (info: DaemonInfo) =>
	Effect.gen(function* () {
		const scriptPath = yield* currentScriptPath();
		const runningFor = yield* uptime(info.startedAt);
		const lines = [
			'Daemon: running',
			`PID: ${info.pid}`,
			`Started: ${info.startedAt}`,
			`Uptime: ${runningFor}`,
			`Executable: ${info.executable}`,
			`Script: ${info.scriptPath}`,
			`Package version: ${info.packageVersion}`,
			`Protocol version: ${info.protocolVersion}`,
			`Socket: ${info.socketPath}`,
			`Data directory: ${info.dataDirectory}`,
			...(info.logsDirectory === undefined
				? []
				: [`Logs directory: ${info.logsDirectory}`]),
			`Runs: ${info.runCount}`,
			`Live services: ${info.liveServiceCount}`,
			`Attached clients: ${info.attachedClientCount}`,
		];
		if (info.packageVersion !== devsessPackageJson.version)
			lines.push(
				`Warning: daemon version ${info.packageVersion} differs from current CLI version ${devsessPackageJson.version}.`,
			);
		if (info.executable !== process.execPath || info.scriptPath !== scriptPath)
			lines.push(
				`Warning: daemon binary path differs from the current CLI (${process.execPath}, ${scriptPath}).`,
			);
		return lines;
	});

const statusFailure = (message: string) =>
	write(message).pipe(
		Effect.andThen(Effect.fail(new DaemonStatusError({ message }))),
	);

const isUnreachable = (cause: unknown) =>
	cause instanceof DaemonClientError && cause.kind === 'unreachable';

const waitForStopped = (
	socketPath: string,
	timeoutMs: number,
): Effect.Effect<void, unknown> => {
	const deadline = Date.now() + timeoutMs;
	const poll: Effect.Effect<void, unknown> = Effect.gen(function* () {
		const runs = yield* Effect.exit(
			readRuns(
				socketPath,
				Math.max(
					1,
					Math.min(deadline - Date.now(), DEFAULT_DAEMON_REQUEST_TIMEOUT_MS),
				),
			),
		);
		if (Exit.isFailure(runs)) {
			const error = Cause.squash(runs.cause);
			if (isUnreachable(error)) return;
			if (error instanceof DaemonClientError && error.kind === 'connect-failed')
				return yield* new CommandError({
					message: error.message,
					cause: error,
				});
		}
		if (Date.now() >= deadline)
			return yield* new CommandError({
				message: `Daemon at ${socketPath} did not stop within ${timeoutMs}ms`,
			});
		yield* Effect.sleep(`${DAEMON_POLL_INTERVAL_MS} millis`);
		return yield* poll;
	});
	return poll;
};

const activeLines = (runs: ReadonlyArray<RunRecord>) => [
	'Live runs:',
	...runs
		.filter(isRunActive)
		.map((run) => `  ${run.projectName}/${run.presetName} ${run.state}`),
];

const refusal = (runs: ReadonlyArray<RunRecord>) =>
	new CommandError({
		message: `Refusing to stop the daemon while runs are live. Re-run with --force. ${runs
			.filter(isRunActive)
			.map((run) => `${run.projectName}/${run.presetName}`)
			.join(', ')}`,
	});

export const stopOutdatedDaemon = (
	socketPath: string,
	runs: ReadonlyArray<RunRecord>,
	force: boolean,
) =>
	Effect.gen(function* () {
		const active = runs.filter(isRunActive);
		if (active.length > 0 && !force) {
			yield* Effect.forEach(activeLines(runs), write, { discard: true });
			return yield* refusal(runs);
		}
		const ownerPid = yield* readSocketOwnerPid(socketPath);
		yield* releaseLaunchdJob;
		const processes = yield* Processes;
		const identity = yield* processes.capture(ownerPid).pipe(
			Effect.mapError(
				(cause) =>
					new CommandError({
						message: `Could not verify daemon process PID ${ownerPid}`,
						cause,
					}),
			),
		);
		const termination = yield* processes.terminate(identity, false).pipe(
			Effect.mapError(
				(cause) =>
					new CommandError({
						message: `Could not terminate outdated daemon PID ${ownerPid}`,
						cause,
					}),
			),
		);
		if (termination === undefined) {
			const response = yield* Effect.exit(readRuns(socketPath));
			if (
				Exit.isFailure(response) &&
				isUnreachable(Cause.squash(response.cause))
			) {
				yield* write('Outdated daemon was already stopped.');
				return;
			}
			return yield* new CommandError({
				message: `Could not stop outdated daemon PID ${ownerPid}: no signal was sent because its process identity could not be verified.`,
			});
		}
		yield* waitForStopped(socketPath, DAEMON_STOP_TIMEOUT_MS);
		yield* write(
			`Stopped outdated daemon PID ${ownerPid} with ${termination === TERMINATION_KILL_SIGNAL ? 'SIGKILL' : 'SIGTERM'}.`,
		);
	});

const fromBootstrapError = (cause: DaemonBootstrapError) =>
	new CommandError({ message: cause.message, cause });

const fromTermination = (cause: DaemonTerminationError) =>
	new CommandError({ message: cause.message, cause: cause.cause });

/** KeepAlive would relaunch a daemon killed by a signal, so the job has to be unloaded before any signal is sent. */
const releaseLaunchdJob = Effect.gen(function* () {
	if (!(yield* usesLaunchd)) return;
	const unloaded = yield* bootoutDaemonJob.pipe(
		Effect.mapError(fromBootstrapError),
	);
	if (unloaded)
		yield* write(
			`Unloaded launchd job ${DAEMON_LAUNCHD_LABEL} so it does not restart the daemon.`,
		);
});

const failureMessage = (cause: unknown) =>
	cause instanceof Error ? cause.message : String(cause);

const stopRunning = (
	socketPath: string,
	force: boolean,
	runs: ReadonlyArray<RunRecord>,
	pid: number,
	stopTimeoutMs: number,
) =>
	Effect.gen(function* () {
		const active = runs.filter(isRunActive);
		if (active.length > 0 && !force)
			yield* Effect.forEach(activeLines(runs), write, { discard: true });
		const result = yield* Effect.exit(
			callDaemon(socketPath, shutdownRequest(force)),
		);
		if (Exit.isFailure(result)) {
			if (active.length > 0 && !force) return yield* refusal(runs);
			const error = Cause.squash(result.cause);
			if (force)
				return yield* terminateAfterFailedShutdown(
					socketPath,
					`the shutdown request failed: ${failureMessage(error)}`,
				);
			return yield* new CommandError({
				message: `Could not shut down daemon: ${failureMessage(error)}`,
				cause: error,
			});
		}
		const stopped = yield* Effect.exit(
			waitForStopped(socketPath, stopTimeoutMs),
		);
		if (Exit.isFailure(stopped)) {
			if (force) {
				const error = Cause.squash(stopped.cause);
				return yield* terminateAfterFailedShutdown(
					socketPath,
					error instanceof CommandError &&
						error.cause instanceof DaemonClientError
						? error.message
						: `it did not exit within ${stopTimeoutMs}ms of the shutdown request`,
				);
			}
			return yield* Effect.failCause(stopped.cause);
		}
		// The socket goes away before the services are stopped, so an unanswered socket does not mean the process is gone.
		const exited = yield* waitForProcessExit(pid, Date.now() + stopTimeoutMs);
		if (!exited) {
			if (force)
				return yield* terminateAfterFailedShutdown(
					socketPath,
					`PID ${pid} was still shutting down ${stopTimeoutMs}ms after it stopped answering`,
					pid,
				);
			return yield* new CommandError({
				message: `Daemon PID ${pid} stopped answering at ${socketPath} but is still shutting down after ${stopTimeoutMs}ms. Wait for it to exit, or re-run with --force to terminate it.`,
			});
		}
		yield* write('Daemon stopped.');
	});

const waitForProcessExit = (pid: number, deadline: number) =>
	waitForProcessExitShared(pid, deadline).pipe(
		Effect.mapError(fromTermination),
	);

const clearDaemonEndpoint = (socketPath: string) =>
	removeStaleSocket(socketPath).pipe(
		Effect.andThen(removeStalePidfile(socketPath)),
		Effect.mapError(fromBootstrapError),
	);

/** Handles a daemon whose socket exists but does not answer: a stale socket is cleared, a live PID needs --force. */
export const stopUnresponsiveDaemon = (
	socketPath: string,
	pid: number | undefined,
	force: boolean,
	termTimeoutMs = PROCESS_TERM_TIMEOUT_MS,
) =>
	Effect.gen(function* () {
		if (pid === undefined) {
			yield* clearDaemonEndpoint(socketPath);
			yield* write(
				`Removed stale daemon socket at ${socketPath}; no daemon process was running.`,
			);
			return;
		}
		if (!force)
			return yield* new CommandError({
				message: `Daemon PID ${pid} is not responding at ${socketPath}. Re-run with --force to terminate it.`,
			});
		yield* releaseLaunchdJob;
		const signal = yield* terminateProcess(pid, termTimeoutMs).pipe(
			Effect.mapError(fromTermination),
		);
		yield* clearDaemonEndpoint(socketPath);
		yield* write(`Stopped unresponsive daemon PID ${pid} with ${signal}.`);
	});

/** `--force` has to land even when the daemon is too busy to shut itself down, so it falls back to signalling the pidfile PID. */
const terminateAfterFailedShutdown = (
	socketPath: string,
	reason: string,
	knownPid?: number,
) =>
	Effect.gen(function* () {
		const pid =
			knownPid === undefined ? yield* liveDaemonPid(socketPath) : knownPid;
		if (pid === undefined)
			return yield* new CommandError({
				message: `Could not shut down daemon at ${socketPath}: ${reason}, and no live daemon PID is recorded beside the socket, so nothing was terminated.`,
			});
		yield* write(
			`Daemon did not shut down (${reason}); terminating PID ${pid}.`,
		);
		yield* stopUnresponsiveDaemon(socketPath, pid, true);
	});

const launchdStatusLines = (location: Parameters<typeof daemonJob>[0]) =>
	Effect.gen(function* () {
		if (!(yield* usesLaunchd)) return [];
		const state = yield* inspectDaemonJob(daemonJob(location)).pipe(
			Effect.mapError(fromBootstrapError),
		);
		const reload =
			state.plist === 'current'
				? ''
				: ' (`devsess daemon restart` brings it up to date)';
		return [
			`Launchd: ${DAEMON_LAUNCHD_LABEL} ${state.loaded ? 'loaded' : 'not loaded'}, plist ${state.plist}${reload}`,
		];
	});

export const status = () =>
	Effect.gen(function* () {
		const location = yield* resolveDaemonLocation;
		const probe = yield* probeDaemon(location.socketPath);
		const launchdLines = yield* launchdStatusLines(location);
		const failure = (message: string) =>
			statusFailure([message, ...launchdLines].join('\n'));
		if (probe._tag === 'not-running')
			return yield* failure('Daemon: not running');
		if (probe._tag === 'connect-failed') return yield* failure(probe.message);
		if (probe._tag === 'unresponsive')
			return yield* failure(
				probe.pid === undefined
					? `Daemon: not responding (socket exists at ${location.socketPath}, but no daemon process is running; \`devsess daemon start\` clears it)`
					: `Daemon: unresponsive\nPID: ${probe.pid}\nSocket: ${location.socketPath}\nRun \`devsess daemon stop --force\` to terminate it.`,
			);
		if (probe._tag === 'outdated') {
			yield* Effect.forEach(
				[
					'Daemon: running, outdated — run `devsess daemon restart`.',
					...launchdLines,
				],
				write,
				{ discard: true },
			);
			return;
		}
		yield* Effect.forEach(
			[...(yield* infoLines(probe.info)), ...launchdLines],
			write,
			{ discard: true },
		);
	});

export const start = () =>
	Effect.gen(function* () {
		const location = yield* resolveDaemonLocation;
		const before = yield* probeDaemon(location.socketPath);
		if (before._tag === 'connect-failed')
			return yield* new CommandError({ message: before.message });
		const wasRunning = before._tag === 'running' || before._tag === 'outdated';
		yield* ensureDaemonCommand(location);
		const after = yield* probeDaemon(location.socketPath);
		if (after._tag === 'running') {
			yield* write(
				`${wasRunning ? 'Daemon already running' : 'Daemon started'} (pid ${after.info.pid}).`,
			);
			return;
		}
		if (after._tag === 'outdated') {
			yield* write(
				`${wasRunning ? 'Daemon already running' : 'Daemon started'}, but it is outdated and does not support info; run \`devsess daemon restart\`.`,
			);
			return;
		}
		return yield* new CommandError({
			message:
				'Daemon bootstrap completed, but the daemon did not respond to info',
		});
	});

export const stop = (force: boolean, stopTimeoutMs = DAEMON_STOP_TIMEOUT_MS) =>
	Effect.gen(function* () {
		const location = yield* resolveDaemonLocation;
		const probe = yield* probeDaemon(location.socketPath);
		if (probe._tag === 'not-running') {
			yield* write('Daemon is not running.');
			return;
		}
		if (probe._tag === 'connect-failed')
			return yield* new CommandError({ message: probe.message });
		if (probe._tag === 'unresponsive') {
			yield* stopUnresponsiveDaemon(location.socketPath, probe.pid, force);
			return;
		}
		if (probe._tag === 'outdated') {
			yield* stopOutdatedDaemon(location.socketPath, probe.runs, force);
			return;
		}
		// Only the refusal needs the run list, and a busy daemon may not answer it.
		const runs = force
			? []
			: yield* readRuns(location.socketPath).pipe(
					Effect.mapError(
						(cause) =>
							new CommandError({
								message: 'Could not read daemon runs before shutdown',
								cause,
							}),
					),
				);
		yield* stopRunning(
			location.socketPath,
			force,
			runs,
			probe.info.pid,
			stopTimeoutMs,
		);
	}).pipe(Effect.provide(Processes.layer));

export const restart = (force: boolean, stopTimeoutMs?: number) =>
	stop(force, stopTimeoutMs).pipe(Effect.andThen(start()));

const requireLaunchd = Effect.gen(function* () {
	if (!(yield* usesLaunchd))
		return yield* new CommandError({
			message:
				'launchd manages the daemon only on macOS with the default state and runtime locations; XDG_STATE_HOME or XDG_RUNTIME_DIR opts out.',
		});
});

export const install = (force: boolean, stopTimeoutMs?: number) =>
	Effect.gen(function* () {
		yield* requireLaunchd;
		const location = yield* resolveDaemonLocation;
		const job = daemonJob(location);
		const state = yield* inspectDaemonJob(job).pipe(
			Effect.mapError(fromBootstrapError),
		);
		// Reloading a changed job stops the daemon it supervises, so stop it the safe way first.
		if (state.loaded && state.plist !== 'current')
			yield* stop(force, stopTimeoutMs);
		yield* installDaemonJob(job).pipe(Effect.mapError(fromBootstrapError));
		yield* write(`Launchd job ${DAEMON_LAUNCHD_LABEL} is installed.`);
		yield* start();
	});

export const uninstall = (force: boolean, stopTimeoutMs?: number) =>
	Effect.gen(function* () {
		yield* requireLaunchd;
		const location = yield* resolveDaemonLocation;
		yield* stop(force, stopTimeoutMs);
		yield* bootoutDaemonJob.pipe(Effect.mapError(fromBootstrapError));
		yield* removeDaemonJobPlist(daemonJob(location)).pipe(
			Effect.mapError(fromBootstrapError),
		);
		yield* write(
			`Launchd job ${DAEMON_LAUNCHD_LABEL} is uninstalled; the next devsess command that needs the daemon installs it again.`,
		);
	});

const daemonStartCommand = Command.make('start', {}, () => start()).pipe(
	Command.withDescription('Start the per-user daemon if it is not running.'),
);
const daemonStopCommand = Command.make(
	'stop',
	{
		force: Flag.Boolean('force').pipe(
			Flag.withDefault(false),
			Flag.withDescription('Stop live runs before shutting down.'),
		),
	},
	(input) => stop(input.force),
).pipe(Command.withDescription('Shut down the per-user daemon.'));
const daemonStatusCommand = Command.make('status', {}, () => status()).pipe(
	Command.withDescription('Show daemon identity, version, socket, and uptime.'),
);
const daemonRestartCommand = Command.make(
	'restart',
	{
		force: Flag.Boolean('force').pipe(
			Flag.withDefault(false),
			Flag.withDescription('Stop live runs before restarting.'),
		),
	},
	(input) => restart(input.force),
).pipe(Command.withDescription('Stop and start the per-user daemon.'));

const daemonInstallCommand = Command.make(
	'install',
	{
		force: Flag.Boolean('force').pipe(
			Flag.withDefault(false),
			Flag.withDescription(
				'Stop live runs when a changed job must be reloaded.',
			),
		),
	},
	(input) => install(input.force),
).pipe(
	Command.withDescription(
		'Install the launchd job that supervises the daemon (macOS).',
	),
);
const daemonUninstallCommand = Command.make(
	'uninstall',
	{
		force: Flag.Boolean('force').pipe(
			Flag.withDefault(false),
			Flag.withDescription('Stop live runs before uninstalling.'),
		),
	},
	(input) => uninstall(input.force),
).pipe(
	Command.withDescription(
		'Stop the daemon and remove its launchd job (macOS).',
	),
);

export const daemonControlCommand = Command.make('daemon', {}).pipe(
	Command.withDescription('Manage the shared per-user daemon.'),
	Command.withSubcommands([
		daemonStartCommand,
		daemonStopCommand,
		daemonStatusCommand,
		daemonRestartCommand,
		daemonInstallCommand,
		daemonUninstallCommand,
	]),
);
