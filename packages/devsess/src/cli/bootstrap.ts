import { spawn } from 'node:child_process';
import { createConnection } from 'node:net';
import { Effect, Schema } from 'effect';

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
	Effect.tryPromise({
		try: () =>
			new Promise<void>((resolve, reject) => {
				const deadline = Date.now() + options.timeoutMs;
				const probe = () => {
					const requestId = crypto.randomUUID();
					const socket = createConnection(options.socketPath);
					let response = '';
					let settled = false;
					const retry = () => {
						if (settled) return;
						settled = true;
						socket.destroy();
						if (Date.now() >= deadline) {
							reject(
								new Error(
									`Timed out waiting for daemon at ${options.socketPath}`,
								),
							);
							return;
						}
						setTimeout(probe, 25);
					};
					socket.once('connect', () => {
						socket.write(
							`${JSON.stringify({ version: 1, requestId, method: 'listRuns', params: {} })}\n`,
						);
					});
					socket.on('data', (data) => {
						response = `${response}${data.toString()}`;
						const newline = response.indexOf('\n');
						if (newline === -1) return;
						try {
							const frame: unknown = JSON.parse(response.slice(0, newline));
							if (
								typeof frame === 'object' &&
								frame !== null &&
								'version' in frame &&
								frame.version === 1 &&
								'requestId' in frame &&
								frame.requestId === requestId
							) {
								settled = true;
								socket.destroy();
								resolve();
								return;
							}
						} catch {}
						retry();
					});
					socket.once('error', retry);
				};
				probe();
			}),
		catch: (cause) =>
			new DaemonBootstrapError({
				message: `Could not complete daemon handshake at ${options.socketPath}`,
				cause,
			}),
	});

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
