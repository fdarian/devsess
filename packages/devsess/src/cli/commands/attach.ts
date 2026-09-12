import { Effect } from 'effect';
import { attachSession } from '../attach-session';
import type { RunRecord } from '../registry';
import { openDaemonStream } from '../terminal';
import {
	CommandError,
	type CommandOptions,
	chooseRun,
	requestId,
	resolveCurrentRuns,
} from './daemon';

const chooseService = (run: RunRecord, serviceName: string | undefined) => {
	const candidates =
		serviceName === undefined
			? run.services
			: run.services.filter((service) => service.name === serviceName);
	const service = candidates[0];
	if (candidates.length === 1 && service !== undefined)
		return Effect.succeed(service);
	if (candidates.length === 0)
		return Effect.fail(
			new CommandError({ message: 'No matching service is running' }),
		);
	return Effect.fail(
		new CommandError({
			message: `Preset ${run.projectName}/${run.presetName} has multiple services. Specify --service: ${candidates.map((candidate) => candidate.name).join(', ')}.`,
		}),
	);
};

/** Attaches one input lease; Ctrl-] returns to the caller and Ctrl-C reaches the service. */
export const attach = (options: CommandOptions) => {
	if (!process.stdin.isTTY || !process.stdout.isTTY)
		return Effect.fail(
			new CommandError({ message: 'Attach requires an interactive terminal' }),
		);
	return Effect.scoped(
		Effect.gen(function* () {
			const resolved = yield* resolveCurrentRuns(options);
			const run = yield* chooseRun(resolved.current, options);
			const service = yield* chooseService(run, options.service);
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
