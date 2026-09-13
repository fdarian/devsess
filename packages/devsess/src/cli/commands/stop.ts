import { Effect } from 'effect';
import { callDaemon } from '../client';
import {
	type CommandOptions,
	chooseRun,
	requestId,
	resolveCurrentRuns,
	write,
} from './daemon';

export const stop = (options: CommandOptions) =>
	resolveCurrentRuns(options).pipe(
		Effect.flatMap((resolved) =>
			chooseRun(resolved.current, options).pipe(
				Effect.flatMap((run) =>
					callDaemon(resolved.location.socketPath, {
						version: 1,
						requestId: requestId(),
						method: 'stopRun',
						params: {
							runId: run.runId,
							...(options.force === true ? { force: true } : {}),
						},
					}).pipe(
						Effect.andThen(
							write(`Stopped ${run.projectName}/${run.presetName}`),
						),
					),
				),
			),
		),
	);
