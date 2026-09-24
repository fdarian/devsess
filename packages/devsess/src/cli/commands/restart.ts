import { Cause, Effect, Exit } from 'effect';
import { callDaemon } from '../client';
import { runSelector } from '../run-id';
import { STOP_REQUEST_TIMEOUT_MS } from '../termination';
import {
	CommandError,
	type CommandOptions,
	chooseRun,
	decodeRunResponse,
	requestId,
	resolveCurrentRuns,
	write,
} from './daemon';
import { chooseServices } from './service-selection';
import {
	formatStartFailure,
	recentOutput,
	unpublishedExits,
	watchStart,
} from './start';

export const restart = (options: CommandOptions) =>
	Effect.gen(function* () {
		const resolved = yield* resolveCurrentRuns();
		const run = yield* chooseRun(
			resolved.current,
			options,
			'restart',
			undefined,
			resolved.local,
		);
		const services = yield* chooseServices(
			run,
			options,
			'restart',
			undefined,
			resolved.runs,
		);
		const updated = yield* callDaemon(
			resolved.location.socketPath,
			{
				version: 1,
				requestId: requestId(),
				method: 'restartServices',
				params: {
					runId: run.runId,
					serviceNames: services.map((service) => service.name),
				},
			},
			STOP_REQUEST_TIMEOUT_MS * services.length,
		).pipe(Effect.flatMap(decodeRunResponse));
		const awaited = new Set(
			services
				.filter((service) => service.awaitPublish === true)
				.map((service) => service.name),
		);
		const immediate = services
			.filter((service) => service.awaitPublish !== true)
			.map((service) => service.name);
		if (immediate.length > 0)
			yield* write(
				`${immediate.join(', ')} ${immediate.length === 1 ? 'does' : 'do'} not publish readiness; restarted once spawned.`,
			);
		if (awaited.size > 0)
			yield* write(
				`Waiting for ${[...awaited].join(', ')} to publish readiness…`,
			);
		const watched =
			awaited.size > 0
				? yield* watchStart(
						resolved.location.socketPath,
						updated,
						awaited,
						new Set(services.map((service) => service.name)),
					)
				: { run: updated, runs: resolved.runs, seen: new Set<string>() };
		const failed = unpublishedExits(watched.run, awaited, watched.seen);
		if (failed.length > 0) {
			const reports = yield* Effect.forEach(failed, (service) =>
				Effect.gen(function* () {
					const output = yield* Effect.exit(
						recentOutput(resolved.location.socketPath, watched.run, service),
					);
					return formatStartFailure(
						watched.run,
						service,
						Exit.isSuccess(output)
							? output.value
							: [`Output unavailable: ${String(Cause.squash(output.cause))}`],
						watched.runs,
					);
				}),
			);
			return yield* new CommandError({
				message: `Restart failed:\n  ${reports.join('\n  ')}`,
			});
		}
		yield* write(
			`Restarted ${services.map((service) => service.name).join(', ')} in ${runSelector(run, resolved.runs)} (${run.runId})`,
		);
	});
