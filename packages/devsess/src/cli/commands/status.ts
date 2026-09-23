import { Effect } from 'effect';
import { FileSystem } from 'effect/FileSystem';
import { callDaemon } from '../client';
import { isRunActive, type RunRecord } from '../registry';
import {
	CommandError,
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
) => {
	const visible = runs.filter((run) => all || isRunActive(run));
	if (visible.length === 0)
		return [
			all
				? 'No recorded runs. See `devsess list` for available presets.'
				: 'Nothing running. See `devsess list` for available presets.',
		];
	return visible.flatMap((run) => [
		`${run.projectName}/${run.presetName} ${isRunActive(run) ? 'running' : 'finished'} [${run.runId.slice(0, 8)}]`,
		`  Started: ${run.startedAt}`,
		...(isRunActive(run) ? [`  Uptime: ${elapsed(run.startedAt, now)}`] : []),
		...run.services.map(
			(service) =>
				`  ${service.name}: ${service.state}${service.process === undefined ? '' : ` pid ${service.process.pid}`}${service.exitCode === undefined ? '' : ` exit ${service.exitCode}`} — ${service.command} (cwd: ${service.cwd})`,
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
		yield* Effect.forEach(formatStatus(visible, options.all), write, {
			discard: true,
		});
	});
