import { Cause, Effect, Exit, Queue } from 'effect';
import { callDaemon } from '../client';
import { serviceExitCode } from '../exit-status';
import { resolvePreset, toServices } from '../preset-resolution';
import type { DaemonRequest } from '../protocol';
import { formatPublishedValue } from '../published-value';
import { isRunActive, type RunRecord, type ServiceRecord } from '../registry';
import { runSelector, shortRunId } from '../run-id';
import { openDaemonStream } from '../terminal';
import type { CommandOptions } from './daemon';
import {
	CommandError,
	decodeRunListResponse,
	decodeRunResponse,
	ensureDaemon,
	requestId,
	resolveDaemonLocation,
	write,
} from './daemon';

export const recentOutput = (
	socketPath: string,
	run: RunRecord,
	service: ServiceRecord,
) =>
	Effect.scoped(
		Effect.gen(function* () {
			const stream = yield* openDaemonStream({
				socketPath,
				request: {
					version: 1,
					requestId: requestId(),
					method: 'tail',
					params: { runId: run.runId, serviceName: service.name },
				},
			});
			let text = '';
			while (true) {
				const frame = yield* Queue.take(stream.frames);
				if (frame._tag === 'output') {
					if (frame.value.event === 'exit') break;
					text = `${text}${frame.value.data}`.slice(-16000);
				} else if (frame._tag === 'error') return yield* frame.error;
				else if (frame._tag === 'closed')
					return yield* new CommandError({
						message: 'Log stream closed before exit',
					});
				else if (!frame.value.ok)
					return yield* new CommandError({
						message:
							frame.value.error === undefined
								? 'Daemon rejected tail request'
								: frame.value.error,
					});
			}
			return text
				.split(/\r?\n/)
				.filter((line) => line.length > 0)
				.slice(-10);
		}),
	).pipe(Effect.timeout('2 seconds'));

const observedRun = (socketPath: string, runId: string) =>
	callDaemon(socketPath, {
		version: 1,
		requestId: requestId(),
		method: 'listRuns',
		params: {},
	}).pipe(
		Effect.flatMap(decodeRunListResponse),
		Effect.flatMap((runs) => {
			const run = runs.find((candidate) => candidate.runId === runId);
			return run === undefined
				? new CommandError({
						message: `Started run ${runId} disappeared from the daemon`,
					})
				: Effect.succeed({ run, runs });
		}),
	);

export const watchStart = (
	socketPath: string,
	initial: RunRecord,
	awaited: ReadonlySet<string> | undefined,
) =>
	Effect.scoped(
		Effect.gen(function* () {
			const deadline = Date.now() + 2000;
			const warningDeadline = Date.now() + 15000;
			const seen = new Set<string>();
			const observed = yield* observedRun(socketPath, initial.runId);
			let run = observed.run;
			let runs = observed.runs;
			let warned = false;
			while (true) {
				for (const service of run.services) {
					if (service.published === undefined || seen.has(service.name))
						continue;
					seen.add(service.name);
					yield* write(
						`${service.name} ready → ${formatPublishedValue(service.published.value)}`,
					);
				}
				if (awaited === undefined) {
					if (Date.now() >= deadline || !isRunActive(run))
						return { run, runs, seen };
				} else {
					const pending = [...awaited].filter((name) => !seen.has(name));
					if (
						pending.length === 0 ||
						pending.some((name) =>
							run.services.some(
								(service) => service.name === name && isFinished(service),
							),
						)
					)
						return { run, runs, seen };
					if (!warned && Date.now() >= warningDeadline) {
						warned = true;
						yield* Effect.sync(() =>
							process.stderr.write(
								`Still waiting for readiness: ${pending.join(', ')}\n${pending.map((name) => `  devsess tail ${runSelector(run, runs)} --service ${name}`).join('\n')}\n`,
							),
						);
					}
				}
				yield* Effect.sleep('100 millis');
				const next = yield* observedRun(socketPath, run.runId);
				run = next.run;
				runs = next.runs;
			}
		}),
	).pipe(
		Effect.onInterrupt(() =>
			awaited === undefined
				? Effect.void
				: write(
						'Stopped waiting; services keep running. See `devsess status`.',
					),
		),
	);

const isFinished = (service: ServiceRecord) =>
	service.state === 'exited' || service.state === 'failed';
export const unpublishedExits = (
	run: RunRecord,
	awaited: ReadonlySet<string>,
	seen: ReadonlySet<string>,
) =>
	run.services.filter(
		(service) =>
			awaited.has(service.name) &&
			!seen.has(service.name) &&
			isFinished(service),
	);
export const isFailure = (service: ServiceRecord) =>
	isFinished(service) &&
	(service.state === 'failed' ||
		service.exitCode !== 0 ||
		(service.signal !== undefined && service.signal > 0));

export const formatStartFailure = (
	run: RunRecord,
	service: ServiceRecord,
	lines: ReadonlyArray<string>,
	runs: ReadonlyArray<RunRecord> = [run],
) =>
	`${service.name}: ${service.state}${service.exitCode === undefined ? ' (exit status unknown)' : ` (exit ${serviceExitCode({ exitCode: service.exitCode, signal: service.signal })})`}\n${lines.map((line) => `    ${line}`).join('\n')}\n  See: devsess tail ${runSelector(run, runs)} --service ${service.name}`;

const clientEnvironment = () =>
	Object.fromEntries(
		Object.entries(process.env).flatMap((entry) => {
			const key = entry[0];
			const value = entry[1];
			return value === undefined || key === undefined ? [] : [[key, value]];
		}),
	);

/** Starts a selected preset after capturing the client environment at this boundary. */
export const start = (options: CommandOptions, interactive: boolean) =>
	Effect.gen(function* () {
		const resolved = yield* resolvePreset(options, interactive);
		const location = yield* resolveDaemonLocation;
		yield* ensureDaemon(location);
		const request: DaemonRequest = {
			version: 1,
			requestId: requestId(),
			method: 'startRun',
			params: {
				runId: requestId(),
				projectName: resolved.preset.projectName,
				presetName: resolved.preset.presetName,
				canonicalCwd: resolved.invocation.canonicalCwd,
				invocationCwd: resolved.invocation.invocationCwd,
				configSnapshot: {
					projectName: resolved.preset.projectName,
					presetName: resolved.preset.presetName,
					preset: resolved.preset.preset,
				},
				environment: clientEnvironment(),
				services: toServices(resolved.preset.preset, resolved.invocation),
			},
		};
		const run = yield* callDaemon(location.socketPath, request).pipe(
			Effect.flatMap(decodeRunResponse),
		);
		const awaited =
			resolved.preset.preset.awaitPublish === true
				? new Set(
						Object.entries(resolved.preset.preset.services)
							.filter((entry) => entry[1].awaitPublish !== false)
							.map((entry) => entry[0]),
					)
				: undefined;
		if (awaited !== undefined && awaited.size > 0)
			yield* write(
				`Waiting for ${[...awaited].join(', ')} to publish readiness…`,
			);
		const watched = yield* watchStart(location.socketPath, run, awaited);
		const observed = watched.run;
		const exited = observed.services.filter(isFinished);
		const report = yield* Effect.forEach(exited, (service) =>
			Effect.gen(function* () {
				const output = yield* Effect.exit(
					recentOutput(location.socketPath, observed, service),
				);
				const lines = Exit.isSuccess(output)
					? output.value
					: [`Output unavailable: ${String(Cause.squash(output.cause))}`];
				return formatStartFailure(observed, service, lines, watched.runs);
			}),
		);
		const summary = report.join('\n  ');
		const missingReadiness =
			awaited !== undefined &&
			unpublishedExits(observed, awaited, watched.seen).length > 0;
		if (
			missingReadiness ||
			(awaited === undefined &&
				observed.services.length > 0 &&
				observed.services.every(isFailure))
		)
			return yield* new CommandError({
				message: `Run ${observed.projectName}/${observed.presetName} [${shortRunId(observed, watched.runs)}] failed shortly after start:\n  ${summary}`,
			});
		yield* write(
			`Started ${resolved.preset.projectName}/${resolved.preset.presetName}: ${run.runId}`,
		);
		if (report.length > 0)
			yield* Effect.sync(() =>
				process.stderr.write(
					`Service exited shortly after start:\n  ${summary}\n`,
				),
			);
	});
