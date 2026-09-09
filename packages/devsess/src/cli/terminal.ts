import { createConnection } from 'node:net';
import { Effect, Queue, Schema } from 'effect';
import {
	type DaemonEvent,
	type DaemonRequest,
	DaemonResponse,
	PROTOCOL_VERSION,
} from './protocol';

export class TerminalTransportError extends Schema.TaggedErrorClass<TerminalTransportError>()(
	'devsess/cli/TerminalTransportError',
	{ message: Schema.String, cause: Schema.optional(Schema.Defect()) },
) {}

type StreamingRequest = Extract<DaemonRequest, { method: 'tail' | 'attach' }>;

type StreamFrame =
	| { readonly _tag: 'response'; readonly value: typeof DaemonResponse.Type }
	| { readonly _tag: 'output'; readonly value: DaemonEvent }
	| { readonly _tag: 'closed' };

const decodeFrame = Schema.decodeUnknownEffect(
	Schema.fromJsonString(
		Schema.Union([
			DaemonResponse,
			Schema.Struct({
				version: Schema.Literal(PROTOCOL_VERSION),
				requestId: Schema.NonEmptyString,
				event: Schema.Literal('output'),
				data: Schema.String,
				offset: Schema.Int,
			}),
		]),
	),
);

/** Opens a daemon stream and preserves it until the caller's scope closes. */
export const openDaemonStream = (options: {
	socketPath: string;
	request: StreamingRequest;
}) =>
	Effect.acquireRelease(
		Effect.gen(function* () {
			const frames = yield* Queue.unbounded<StreamFrame>();
			const socket = yield* Effect.tryPromise({
				try: () =>
					new Promise<ReturnType<typeof createConnection>>(
						(resolve, reject) => {
							const connection = createConnection(options.socketPath);
							connection.once('connect', () => {
								connection.write(`${JSON.stringify(options.request)}\n`);
								resolve(connection);
							});
							connection.once('error', reject);
						},
					),
				catch: (cause) =>
					new TerminalTransportError({
						message: `Could not contact daemon at ${options.socketPath}`,
						cause,
					}),
			});
			let buffer = '';
			socket.on('data', (chunk) => {
				buffer = `${buffer}${chunk.toString()}`;
				const lines = buffer.split('\n');
				buffer = lines.pop() ?? '';
				for (const line of lines) {
					if (line.length === 0) continue;
					Effect.runFork(
						decodeFrame(line).pipe(
							Effect.flatMap((frame) =>
								'requestId' in frame && 'event' in frame
									? Queue.offer(frames, { _tag: 'output', value: frame })
									: Queue.offer(frames, { _tag: 'response', value: frame }),
							),
						),
					);
				}
			});
			socket.once('close', () => Queue.offerUnsafe(frames, { _tag: 'closed' }));
			socket.once('error', () => Queue.offerUnsafe(frames, { _tag: 'closed' }));
			return { frames, socket };
		}),
		(stream) =>
			Effect.sync(() => {
				stream.socket.destroy();
			}),
	);
