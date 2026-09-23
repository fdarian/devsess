import { Cause, Effect, Exit, Queue } from 'effect';
import { ServiceExitError, serviceExit } from '../exit-status';
import { isRunActive, type RunRecord } from '../registry';
import { openDaemonStream, type TerminalTransportError } from '../terminal';
import {
	CommandError,
	type CommandOptions,
	chooseRun,
	type DaemonLocation,
	requestId,
	resolveCurrentRuns,
} from './daemon';
import { chooseServices } from './service-selection';

const tailService = (
	location: DaemonLocation,
	run: RunRecord,
	service: RunRecord['services'][number],
	prefix: boolean,
) =>
	openDaemonStream({
		socketPath: location.socketPath,
		request: {
			version: 1,
			requestId: requestId(),
			method: 'tail',
			params: { runId: run.runId, serviceName: service.name },
		},
	}).pipe(
		Effect.flatMap((stream) => {
			const read = (): Effect.Effect<void, CommandError | ServiceExitError> =>
				Effect.suspend(() =>
					Queue.take(stream.frames).pipe(
						Effect.flatMap((frame) => {
							if (frame._tag === 'output') {
								const event = frame.value;
								if (event.event === 'output')
									return Effect.sync(() =>
										process.stdout.write(
											prefix ? `[${service.name}] ${event.data}` : event.data,
										),
									).pipe(Effect.andThen(read));
								const exitError = serviceExit(event);
								return exitError === undefined
									? Effect.void
									: Effect.fail(exitError);
							}
							if (frame._tag === 'closed')
								return Effect.fail(
									new CommandError({ message: 'Daemon output stream closed' }),
								);
							if (frame._tag === 'error')
								return Effect.fail(
									new CommandError({ message: frame.error.message }),
								);
							if (frame.value.ok) return read();
							if (frame.value.error === undefined)
								return Effect.fail(
									new CommandError({
										message: 'Daemon rejected tail request without an error',
									}),
								);
							return Effect.fail(
								new CommandError({ message: frame.value.error }),
							);
						}),
					),
				);
			return read();
		}),
	);

type TailFailure = CommandError | ServiceExitError | TerminalTransportError;

/** Streams all matching services, qualifying output when more than one is selected. */
export const tail = (options: CommandOptions) =>
	Effect.scoped(
		resolveCurrentRuns().pipe(
			Effect.flatMap((resolved) =>
				chooseRun(
					resolved.current,
					options,
					'tail',
					undefined,
					resolved.localRuns,
					resolved.runs,
				).pipe(
					Effect.flatMap((run) =>
						Effect.gen(function* () {
							if (!isRunActive(run))
								yield* Effect.sync(() =>
									process.stderr.write(
										`${run.projectName}/${run.presetName} [${run.runId.slice(0, 8)}] is not running; replaying its last output.\n`,
									),
								);
							const services = yield* chooseServices(run, options, 'tail');
							const completions =
								yield* Queue.unbounded<Exit.Exit<void, TailFailure>>();
							for (const service of services)
								yield* tailService(
									resolved.location,
									run,
									service,
									services.length > 1,
								).pipe(
									Effect.exit,
									Effect.flatMap((result) => Queue.offer(completions, result)),
									Effect.forkScoped({ startImmediately: true }),
								);
							let firstExitFailure: ServiceExitError | undefined;
							let firstOtherFailure: TailFailure | undefined;
							for (let index = 0; index < services.length; index += 1) {
								const result = yield* Queue.take(completions);
								const failure = Exit.match(result, {
									onSuccess: () => undefined,
									onFailure: (cause) => Cause.squash(cause) as TailFailure,
								});
								if (failure === undefined) continue;
								if (failure instanceof ServiceExitError) {
									if (firstExitFailure === undefined)
										firstExitFailure = failure;
								} else if (firstOtherFailure === undefined) {
									firstOtherFailure = failure;
								}
							}
							if (firstOtherFailure !== undefined)
								return yield* Effect.fail(firstOtherFailure);
							if (firstExitFailure !== undefined)
								return yield* Effect.fail(firstExitFailure);
							return;
						}),
					),
				),
			),
		),
	);
