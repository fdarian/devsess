import { Effect } from 'effect';
import { FileSystem } from 'effect/FileSystem';
import { callDaemon } from '../client';
import { serviceExitCode } from '../exit-status';
import { captureInvocation } from '../project-matching';
import { isRunActive, type RunRecord } from '../registry';
import {
	CommandError,
	containsPath,
	decodeRunListResponse,
	requestId,
	resolveDaemonLocation,
	write,
} from './daemon';

const elapsed = (startedAt: string, now: number) => {
	const duration = Math.max(
		0,
		Math.floor((now - Date.parse(startedAt)) / 1000),
	);
	if (!Number.isFinite(duration)) return 'unknown uptime';
	const hours = Math.floor(duration / 3600);
	const minutes = Math.floor((duration % 3600) / 60);
	return hours > 0 ? `${hours}h ${minutes}m` : `${minutes}m ${duration % 60}s`;
};

export const formatStatus = (
	runs: ReadonlyArray<RunRecord>,
	all: boolean,
	now = Date.now(),
	currentCwd?: string,
) => {
	const visible = runs.filter((run) => all || isRunActive(run));
	if (visible.length === 0) {
		const empty = all
			? 'No recorded runs. See `devsess list` for available presets.'
			: 'Nothing running. See `devsess list` for available presets.';
		if (all) return [empty];
		const finished = runs.filter((run) => !isRunActive(run));
		const local =
			currentCwd === undefined
				? []
				: finished.filter((run) => containsPath(run.canonicalCwd, currentCwd));
		const latest = (local.length > 0 ? local : finished)
			.slice()
			.sort((left, right) => right.startedAt.localeCompare(left.startedAt))[0];
		if (latest === undefined) return [empty];
		return [
			empty,
			`Last run: ${latest.projectName}/${latest.presetName} [${latest.runId.slice(0, 8)}] finished (started ${elapsed(latest.startedAt, now)} ago) — ${latest.services.map((service) => `${service.name} ${service.exitCode === undefined ? 'exit unknown' : `exit ${serviceExitCode({ exitCode: service.exitCode, signal: service.signal })}`}`).join(', ')}. See: devsess tail ${latest.projectName}/${latest.presetName} --run ${latest.runId}`,
		];
	}
	return visible.flatMap((run) => [
		`${run.projectName}/${run.presetName} ${isRunActive(run) ? 'running' : 'finished'} [${run.runId.slice(0, 8)}]`,
		`  Started: ${run.startedAt}`,
		...(isRunActive(run) ? [`  Uptime: ${elapsed(run.startedAt, now)}`] : []),
		...run.services.map(
			(service) =>
				`  ${service.name}: ${service.state === 'failed' && service.exitCode === 0 && service.signal === undefined ? 'exited' : service.state}${service.process === undefined ? '' : ` pid ${service.process.pid}`}${service.exitCode === undefined ? '' : ` exit ${serviceExitCode({ exitCode: service.exitCode, signal: service.signal })}`}${service.signal === undefined || service.signal === 0 ? '' : ` (signal ${service.signal})`} — ${service.command} (cwd: ${service.cwd})`,
		),
	]);
};

export const status = (options: { project?: string; all: boolean }) =>
	Effect.gen(function* () {
		const location = yield* resolveDaemonLocation;
		const fileSystem = yield* FileSystem;
		if (!(yield* fileSystem.exists(location.socketPath))) {
			yield* write(
				'Daemon is not running. See `devsess list` for available presets.',
			);
			return;
		}
		const runs = yield* callDaemon(location.socketPath, {
			version: 1,
			requestId: requestId(),
			method: 'listRuns',
			params: {},
		}).pipe(
			Effect.flatMap(decodeRunListResponse),
			Effect.catchTag('DaemonClientError', (error) =>
				error.kind === 'unreachable' &&
				error.cause instanceof Error &&
				'code' in error.cause &&
				(error.cause.code === 'ENOENT' || error.cause.code === 'ECONNREFUSED')
					? write(
							'Daemon is not running. See `devsess list` for available presets.',
						).pipe(Effect.as(undefined))
					: new CommandError({
							message: `Daemon is not responding at ${location.socketPath}`,
							cause: error,
						}),
			),
		);
		if (runs === undefined) return;
		const visible =
			options.project === undefined
				? runs
				: runs.filter((run) => run.projectName === options.project);
		const invocation = yield* captureInvocation(process.cwd());
		yield* Effect.forEach(
			formatStatus(visible, options.all, Date.now(), invocation.canonicalCwd),
			write,
			{
				discard: true,
			},
		);
	});
