import { createConnection } from 'node:net';
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

export const callDaemon = (socketPath: string, request: DaemonRequest) =>
	Effect.tryPromise({
		try: () =>
			new Promise<string>((resolve, reject) => {
				const socket = createConnection(socketPath);
				let input = '';
				socket.once('connect', () =>
					socket.write(`${JSON.stringify(request)}\n`),
				);
				socket.on('data', (chunk) => {
					input += chunk.toString();
					const boundary = input.indexOf('\n');
					if (boundary === -1) return;
					socket.destroy();
					resolve(input.slice(0, boundary));
				});
				socket.once('error', reject);
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
					return new DaemonClientError({ message: 'Daemon rejected the request without an error' });
				}
				return new DaemonClientError({
					message: response.error,
				});
			}
			return Effect.succeed(response.result);
		}),
	);
