import { spawn } from 'node:child_process';
import { Effect, Schedule, Schema } from 'effect';
import { callDaemon } from './client';

export class DaemonBootstrapError extends Schema.TaggedErrorClass<DaemonBootstrapError>()(
	'DaemonBootstrapError',
	{
		message: Schema.String,
		cause: Schema.optional(Schema.Defect()),
	},
) {}

export const awaitDaemonHandshake = (options: {
	socketPath: string;
	timeoutMs: number;
}) =>
	callDaemon(
		options.socketPath,
		{
			version: 1,
			requestId: crypto.randomUUID(),
			method: 'listRuns',
			params: {},
		},
		Math.min(options.timeoutMs, 250),
	).pipe(
		Effect.retry({
			schedule: Schedule.spaced('25 millis'),
			times: Math.ceil(options.timeoutMs / 25),
		}),
		Effect.asVoid,
		Effect.mapError(
			(cause) =>
				new DaemonBootstrapError({
					message: `Could not complete daemon handshake at ${options.socketPath}`,
					cause,
				}),
		),
	);

export const launchDetachedDaemon = (options: {
	command: string;
	args: Array<string>;
}) =>
	Effect.try({
		try: () => {
			const child = spawn(options.command, options.args, {
				detached: true,
				stdio: 'ignore',
			});
			child.unref();
			if (child.pid === undefined) {
				throw new Error(
					`Detached daemon ${options.command} did not receive a PID`,
				);
			}
			return child.pid;
		},
		catch: (cause) =>
			new DaemonBootstrapError({
				message: `Could not launch detached daemon ${options.command}`,
				cause,
			}),
	});
