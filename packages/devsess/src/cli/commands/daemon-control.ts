import { execFile } from 'node:child_process';
import { Cause, Effect, Exit, Runtime, Schema } from 'effect';
import { FileSystem } from 'effect/FileSystem';
import { Command, Flag } from 'effect/unstable/cli';
import devsessPackageJson from '../../../package.json' with { type: 'json' };
import { callDaemon, DaemonClientError } from '../client';
import { Processes } from '../processes';
import type { DaemonInfo, DaemonRequest } from '../protocol';
import { DaemonInfo as DaemonInfoSchema, PROTOCOL_VERSION } from '../protocol';
import type { RunRecord } from '../registry';
import {
	PROCESS_INSPECTION_TIMEOUT_MS,
	TERMINATION_KILL_SIGNAL,
} from '../termination';
import {
	CommandError,
	decodeRunListResponse,
	ensureDaemon as ensureDaemonCommand,
	isRunActive,
	requestId,
	resolveDaemonLocation,
	write,
} from './daemon';

const DAEMON_STOP_TIMEOUT_MS = 12_000;
const DAEMON_POLL_INTERVAL_MS = 50;

export class DaemonStatusError extends Schema.TaggedErrorClass<DaemonStatusError>()(
	'DaemonStatusError',
	{ message: Schema.String },
) {
	override readonly [Runtime.errorExitCode] = 3;
	override readonly [Runtime.errorReported] = false;
}

type DaemonProbe =
	| { readonly _tag: 'not-running' }
	| { readonly _tag: 'not-responding' }
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

const readRuns = (socketPath: string) =>
	callDaemon(socketPath, listRunsRequest()).pipe(
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
		if (!(yield* socketExists(socketPath)))
			return { _tag: 'not-running' } as const;
		const info = yield* Effect.exit(readInfo(socketPath));
		if (Exit.isSuccess(info))
			return { _tag: 'running', info: info.value } as const;
		const error = Cause.squash(info.cause);
		if (!(error instanceof DaemonClientError) || error.kind !== 'rejected')
			return { _tag: 'not-responding' } as const;
		const runs = yield* Effect.exit(readRuns(socketPath));
		if (Exit.isSuccess(runs))
			return { _tag: 'outdated', runs: runs.value } as const;
		return { _tag: 'not-responding' } as const;
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
	const scriptPath = process.argv[1];
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
	deadline: number,
): Effect.Effect<void, unknown> =>
	Effect.gen(function* () {
		const runs = yield* Effect.exit(readRuns(socketPath));
		if (Exit.isFailure(runs)) {
			const error = Cause.squash(runs.cause);
			if (isUnreachable(error)) return;
		} else if (Date.now() >= deadline) {
			return yield* new CommandError({
				message: `Daemon at ${socketPath} did not stop within ${DAEMON_STOP_TIMEOUT_MS}ms`,
			});
		}
		if (Date.now() >= deadline)
			return yield* new CommandError({
				message: `Daemon at ${socketPath} did not stop within ${DAEMON_STOP_TIMEOUT_MS}ms`,
			});
		yield* Effect.sleep(`${DAEMON_POLL_INTERVAL_MS} millis`);
		return yield* waitForStopped(socketPath, deadline);
	});

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
		yield* waitForStopped(socketPath, Date.now() + DAEMON_STOP_TIMEOUT_MS);
		yield* write(
			`Stopped outdated daemon PID ${ownerPid} with ${termination === TERMINATION_KILL_SIGNAL ? 'SIGKILL' : 'SIGTERM'}.`,
		);
	});

const stopRunning = (
	socketPath: string,
	force: boolean,
	runs: ReadonlyArray<RunRecord>,
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
			return yield* new CommandError({
				message: `Could not shut down daemon: ${error instanceof Error ? error.message : String(error)}`,
				cause: error,
			});
		}
		yield* waitForStopped(socketPath, Date.now() + DAEMON_STOP_TIMEOUT_MS);
		yield* write('Daemon stopped.');
	});

export const status = () =>
	Effect.gen(function* () {
		const location = yield* resolveDaemonLocation;
		const probe = yield* probeDaemon(location.socketPath);
		if (probe._tag === 'not-running')
			return yield* statusFailure('Daemon: not running');
		if (probe._tag === 'not-responding')
			return yield* statusFailure(
				`Daemon: not responding (socket exists at ${location.socketPath})`,
			);
		if (probe._tag === 'outdated') {
			yield* write('Daemon: running, outdated — run `devsess daemon restart`.');
			return;
		}
		yield* Effect.forEach(yield* infoLines(probe.info), write, {
			discard: true,
		});
	});

export const start = () =>
	Effect.gen(function* () {
		const location = yield* resolveDaemonLocation;
		const before = yield* probeDaemon(location.socketPath);
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

export const stop = (force: boolean) =>
	Effect.gen(function* () {
		const location = yield* resolveDaemonLocation;
		const probe = yield* probeDaemon(location.socketPath);
		if (probe._tag === 'not-running') {
			yield* write('Daemon is not running.');
			return;
		}
		if (probe._tag === 'not-responding')
			return yield* new CommandError({
				message: `Daemon socket exists at ${location.socketPath}, but the daemon is not responding.`,
			});
		if (probe._tag === 'outdated') {
			yield* stopOutdatedDaemon(location.socketPath, probe.runs, force);
			return;
		}
		const runs = yield* readRuns(location.socketPath).pipe(
			Effect.mapError(
				(cause) =>
					new CommandError({
						message: 'Could not read daemon runs before shutdown',
						cause,
					}),
			),
		);
		yield* stopRunning(location.socketPath, force, runs);
	}).pipe(Effect.provide(Processes.layer));

export const restart = (force: boolean) =>
	stop(force).pipe(Effect.andThen(start()));

const daemonStartCommand = Command.make('start', {}, () => start());
const daemonStopCommand = Command.make(
	'stop',
	{ force: Flag.boolean('force') },
	(input) => stop(input.force),
);
const daemonStatusCommand = Command.make('status', {}, () => status());
const daemonRestartCommand = Command.make(
	'restart',
	{ force: Flag.boolean('force') },
	(input) => restart(input.force),
);

export const daemonControlCommand = Command.make('daemon', {}).pipe(
	Command.withSubcommands([
		daemonStartCommand,
		daemonStopCommand,
		daemonStatusCommand,
		daemonRestartCommand,
	]),
);
