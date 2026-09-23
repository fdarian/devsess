import { Effect } from 'effect';
import { attachSession } from '../attach-session';
import { serviceExitCode } from '../exit-status';
import { isRunActive, type RunRecord } from '../registry';
import { openDaemonStream } from '../terminal';
import {
	CommandError,
	type CommandOptions,
	chooseRun,
	requestId,
	resolveCurrentRuns,
} from './daemon';
import { chooseServices } from './service-selection';

export const finishedAttachError = (
	run: RunRecord,
	options: CommandOptions,
) => {
	const services =
		options.service === undefined
			? run.services
			: run.services.filter((service) => service.name === options.service);
	if (services.length === 0)
		return new CommandError({
			message: `Service ${options.service} was not found in ${run.projectName}/${run.presetName}`,
		});
	return new CommandError({
		message: `${run.projectName}/${run.presetName} is not running. ${services.map((service) => `${service.name}: ${service.state}${service.exitCode === undefined ? ' (exit status unknown)' : ` (exit ${serviceExitCode({ exitCode: service.exitCode, signal: service.signal })})`}. See output: devsess tail ${run.projectName}/${run.presetName} --run ${run.runId} --service ${service.name}`).join('\n')}`,
	});
};

/** Attaches one input lease; Ctrl-] returns to the caller and Ctrl-C reaches the service. */
export const attach = (options: CommandOptions) => {
	return Effect.scoped(
		Effect.gen(function* () {
			const resolved = yield* resolveCurrentRuns();
			const run = yield* chooseRun(
				resolved.current,
				options,
				'attach',
				undefined,
				resolved.localRuns,
				resolved.runs,
			);
			if (!isRunActive(run)) return yield* finishedAttachError(run, options);
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
