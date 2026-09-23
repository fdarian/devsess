import { Effect } from 'effect';
import { attachSession } from '../attach-session';
import { openDaemonStream } from '../terminal';
import {
	CommandError,
	type CommandOptions,
	chooseRun,
	requestId,
	resolveCurrentRuns,
} from './daemon';
import { chooseServices } from './service-selection';

/** Attaches one input lease; Ctrl-] returns to the caller and Ctrl-C reaches the service. */
export const attach = (options: CommandOptions) => {
	return Effect.scoped(
		Effect.gen(function* () {
			const resolved = yield* resolveCurrentRuns();
			const run = yield* chooseRun(resolved.current, options, 'attach');
			const services = yield* chooseServices(run, options, 'attach');
			if (!process.stdin.isTTY || !process.stdout.isTTY)
				return yield* new CommandError({
					message: 'Attach requires an interactive terminal',
				});
			const service = services[0];
			if (service === undefined)
				return yield* new CommandError({ message: 'No live service found' });
			const stream = yield* openDaemonStream({
				socketPath: resolved.location.socketPath,
				request: {
					version: 1,
					requestId: requestId(),
					method: 'attach',
					params: { runId: run.runId, serviceName: service.name },
				},
			});
			return yield* attachSession({
				location: resolved.location,
				run,
				service,
				stream,
				requestId,
				error: (message) => new CommandError({ message }),
			});
		}),
	);
};
