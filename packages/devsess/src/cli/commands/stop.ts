import { Effect } from 'effect';
import { callDaemon } from '../client';
import { STOP_REQUEST_TIMEOUT_MS } from '../termination';
import {
	type CommandOptions,
	chooseRun,
	requestId,
	resolveCurrentRuns,
	write,
} from './daemon';
import { chooseServices } from './service-selection';

export const stop = (options: CommandOptions) =>
	Effect.gen(function* () {
		const resolved = yield* resolveCurrentRuns();
		const run = yield* chooseRun(
			resolved.current,
			options,
			'stop',
			undefined,
			resolved.local,
		);
		const force = options.force === true ? { force: true } : {};
		if (options.service !== undefined) {
			const services = yield* chooseServices(
				run,
				options,
				'stop',
				undefined,
				resolved.runs,
			);
			yield* callDaemon(
				resolved.location.socketPath,
				{
					version: 1,
					requestId: requestId(),
					method: 'stopServices',
					params: {
						runId: run.runId,
						serviceNames: services.map((service) => service.name),
						...force,
					},
				},
				STOP_REQUEST_TIMEOUT_MS,
			);
			yield* write(
				`Stopped ${services.map((service) => service.name).join(', ')} in ${run.projectName}/${run.presetName}`,
			);
			return;
		}
		yield* callDaemon(
			resolved.location.socketPath,
			{
				version: 1,
				requestId: requestId(),
				method: 'stopRun',
				params: { runId: run.runId, ...force },
			},
			STOP_REQUEST_TIMEOUT_MS,
		);
		yield* write(`Stopped ${run.projectName}/${run.presetName}`);
	});
