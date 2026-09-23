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

export const stop = (options: CommandOptions) =>
	resolveCurrentRuns().pipe(
		Effect.flatMap((resolved) =>
			chooseRun(
				resolved.current,
				options,
				'stop',
				undefined,
				resolved.local,
			).pipe(
				Effect.flatMap((run) =>
					callDaemon(
						resolved.location.socketPath,
						{
							version: 1,
							requestId: requestId(),
							method: 'stopRun',
							params: {
								runId: run.runId,
								...(options.force === true ? { force: true } : {}),
							},
						},
						STOP_REQUEST_TIMEOUT_MS,
					).pipe(
						Effect.andThen(
							write(`Stopped ${run.projectName}/${run.presetName}`),
						),
					),
				),
			),
		),
	);
