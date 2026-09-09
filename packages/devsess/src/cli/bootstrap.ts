import { spawn } from 'node:child_process';
import { createConnection } from 'node:net';
import { Data, Effect } from 'effect';

export class DaemonBootstrapError extends Data.TaggedError(
	'DaemonBootstrapError',
)<{
	message: string;
	cause?: unknown;
}> {}

const HANDSHAKE_REQUEST = 'devsess/handshake\n';
const HANDSHAKE_RESPONSE = 'devsess/ready\n';

export const awaitDaemonHandshake = (options: {
	socketPath: string;
	timeoutMs: number;
}) =>
	Effect.tryPromise({
		try: () =>
			new Promise<void>((resolve, reject) => {
				const socket = createConnection(options.socketPath);
				const timer = setTimeout(() => {
					socket.destroy();
					reject(
						new Error(
							`Timed out waiting for daemon handshake at ${options.socketPath}`,
						),
					);
				}, options.timeoutMs);

				const finish = (result: () => void) => {
					clearTimeout(timer);
					socket.destroy();
					result();
				};

				socket.once('connect', () => socket.write(HANDSHAKE_REQUEST));
				socket.once('data', (data) => {
					if (data.toString() !== HANDSHAKE_RESPONSE) {
						finish(() =>
							reject(new Error('Daemon returned an invalid handshake')),
						);
						return;
					}
					finish(resolve);
				});
				socket.once('error', (cause) => finish(() => reject(cause)));
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
