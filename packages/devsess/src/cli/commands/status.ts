import { Effect } from 'effect';
import { FileSystem } from 'effect/FileSystem';
import { callDaemon } from '../client';
import { serviceExitCode } from '../exit-status';
import { captureInvocation } from '../project-matching';
import { formatPublishedValue } from '../published-value';
import { isRunActive, type RunRecord, type ServiceRecord } from '../registry';
import { runSelector, shortRunId } from '../run-id';
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

export const formatService = (service: ServiceRecord) => {
	const state =
		service.state === 'failed' &&
		service.exitCode === 0 &&
		service.signal === undefined
			? 'exited'
			: service.state;
	const readiness = service.published === undefined ? '' : ' ready';
	const pid =
		service.process === undefined ? '' : ` pid ${service.process.pid}`;
	const exit =
		service.exitCode === undefined
			? ''
			: ` exit ${serviceExitCode({ exitCode: service.exitCode, signal: service.signal })}`;
	const signal =
		service.signal === undefined || service.signal === 0
			? ''
			: ` (signal ${service.signal})`;
	const value =
		service.published === undefined
			? ''
			: ` — ${formatPublishedValue(service.published.value)}`;
	return `  ${service.name}: ${state}${readiness}${pid}${exit}${signal} — ${service.command} (cwd: ${service.cwd})${value}`;
};

export const formatStatus = (
	runs: ReadonlyArray<RunRecord>,
	all: boolean,
	now = Date.now(),
	currentCwd?: string,
	knownRuns: ReadonlyArray<RunRecord> = runs,
) => {
	const visible = runs.filter(isRunActive);
	if (visible.length === 0) {
		const empty = 'Nothing running. See `devsess list` for available presets.';
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
			`Last run: ${latest.projectName}/${latest.presetName} [${shortRunId(latest, knownRuns)}] finished (started ${elapsed(latest.startedAt, now)} ago) — ${latest.services.map((service) => `${service.name} ${service.exitCode === undefined ? 'exit unknown' : `exit ${serviceExitCode({ exitCode: service.exitCode, signal: service.signal })}`}`).join(', ')}. See: devsess tail ${runSelector(latest, knownRuns)}`,
		];
	}
	const detailed = (run: RunRecord) =>
		all ||
		currentCwd === undefined ||
		containsPath(run.canonicalCwd, currentCwd);
	const location = (run: RunRecord) =>
		visible.some(
			(other) =>
				other.runId !== run.runId &&
				other.projectName === run.projectName &&
				other.presetName === run.presetName &&
				other.canonicalCwd !== run.canonicalCwd,
		)
			? ` — ${run.canonicalCwd}`
			: '';
	const lines = visible.flatMap((run) =>
		detailed(run)
			? formatRun(run, now, knownRuns, location(run))
			: [formatRunLine(run, now, knownRuns, location(run))],
	);
	return visible.every(detailed)
		? lines
		: [
				...lines,
				'Other projects are summarized. See `devsess status -a` for details.',
			];
};

const formatRunLine = (
	run: RunRecord,
	now: number,
	knownRuns: ReadonlyArray<RunRecord>,
	location: string,
) => {
	const ready = run.services.filter(
		(service) => service.published !== undefined,
	);
	const readiness = ready.length === 0 ? '' : `, ${ready.length} ready`;
	return `${run.projectName}/${run.presetName} running [${shortRunId(run, knownRuns)}]${location} — up ${elapsed(run.startedAt, now)}, ${run.services.length} ${run.services.length === 1 ? 'service' : 'services'}${readiness}`;
};

const formatRun = (
	run: RunRecord,
	now: number,
	knownRuns: ReadonlyArray<RunRecord>,
	location: string,
) => [
	`${run.projectName}/${run.presetName} ${isRunActive(run) ? 'running' : 'finished'} [${shortRunId(run, knownRuns)}]${location}`,
	`  Started: ${run.startedAt}`,
	...(isRunActive(run) ? [`  Uptime: ${elapsed(run.startedAt, now)}`] : []),
	...run.services.map(formatService),
];

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
			formatStatus(
				visible,
				options.all || options.project !== undefined,
				Date.now(),
				invocation.canonicalCwd,
				runs,
			),
			write,
			{
				discard: true,
			},
		);
	});
