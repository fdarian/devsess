import { Effect, Queue } from 'effect';
import { type ServiceExitError, serviceExit } from '../exit-status';
import type { RunRecord } from '../registry';
import { openDaemonStream } from '../terminal';
import {
	CommandError,
	type CommandOptions,
	chooseRun,
	type DaemonLocation,
	requestId,
	resolveCurrentRuns,
} from './daemon';

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

/** Streams all matching services, qualifying output when more than one is selected. */
export const tail = (options: CommandOptions) =>
	Effect.scoped(
		resolveCurrentRuns(options).pipe(
			Effect.flatMap((resolved) =>
				chooseRun(resolved.current, options).pipe(
					Effect.flatMap((run) => {
						const services =
							options.service === undefined
								? run.services
								: run.services.filter(
										(service) => service.name === options.service,
									);
						if (services.length === 0)
							return Effect.fail(
								new CommandError({ message: 'No matching service is running' }),
							);
						return Effect.all(
							services.map((service) =>
								tailService(
									resolved.location,
									run,
									service,
									services.length > 1,
								),
							),
							{ concurrency: 'unbounded', discard: true },
						);
					}),
				),
			),
		),
	);
