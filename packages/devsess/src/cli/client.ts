import { createConnection } from 'node:net';
import { StringDecoder } from 'node:string_decoder';
import { Effect, Schema } from 'effect';
import {
	type DaemonRequest,
	DaemonResponse,
	PROTOCOL_VERSION,
} from './protocol';

export class DaemonClientError extends Schema.TaggedErrorClass<DaemonClientError>()(
	'DaemonClientError',
	{ message: Schema.String, cause: Schema.optional(Schema.Defect()) },
) {}

const decodeResponse = Schema.decodeUnknownEffect(
	Schema.fromJsonString(DaemonResponse),
);

export const callDaemon = (
	socketPath: string,
	request: DaemonRequest,
	timeoutMs = 5_000,
) =>
	Effect.tryPromise({
		try: () =>
			new Promise<string>((resolve, reject) => {
				const socket = createConnection(socketPath);
				let input = '';
				const decoder = new StringDecoder('utf8');
				let settled = false;
				const finish = (result: () => void) => {
					if (settled) return;
					settled = true;
					clearTimeout(timer);
					socket.destroy();
					result();
				};
				const timer = setTimeout(
					() =>
						finish(() =>
							reject(new Error(`Timed out contacting daemon at ${socketPath}`)),
						),
					timeoutMs,
				);
				socket.once('connect', () =>
					socket.write(`${JSON.stringify(request)}\n`),
				);
				socket.on('data', (chunk) => {
					input += decoder.write(chunk);
					const boundary = input.indexOf('\n');
					if (boundary === -1) return;
					finish(() => resolve(input.slice(0, boundary)));
				});
				socket.once('close', () =>
					finish(() =>
						reject(new Error('Daemon closed the connection before replying')),
					),
				);
				socket.once('error', (cause) => finish(() => reject(cause)));
			}),
		catch: (cause) =>
			new DaemonClientError({
				message: `Could not contact daemon at ${socketPath}`,
				cause,
			}),
	}).pipe(
		Effect.flatMap((raw) =>
			decodeResponse(raw).pipe(
				Effect.mapError(
					(cause) =>
						new DaemonClientError({
							message: 'Daemon returned an invalid response',
							cause,
						}),
				),
			),
		),
		Effect.flatMap((response) => {
			if (response.version !== PROTOCOL_VERSION) {
				return new DaemonClientError({
					message: `Daemon protocol version ${response.version} is incompatible`,
				});
			}
			if (response.requestId !== request.requestId) {
				return new DaemonClientError({
					message: 'Daemon response ID did not match',
				});
			}
			if (!response.ok) {
				if (response.error === undefined) {
					return new DaemonClientError({
						message: 'Daemon rejected the request without an error',
					});
				}
				return new DaemonClientError({
					message: response.error,
				});
			}
			return Effect.succeed(response.result);
		}),
	);
