import { createConnection } from 'node:net';
import { Effect, Fiber, Queue, Schema } from 'effect';
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

export type DaemonStreamFrame =
	| { readonly _tag: 'response'; readonly value: typeof DaemonResponse.Type }
	| { readonly _tag: 'output'; readonly value: DaemonEvent }
	| { readonly _tag: 'error'; readonly error: TerminalTransportError }
	| { readonly _tag: 'closed' };

export type DaemonStream = {
	readonly frames: Queue.Queue<DaemonStreamFrame>;
};

export const decodeDaemonStreamFrame = Schema.decodeUnknownEffect(
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
			const frames = yield* Queue.unbounded<DaemonStreamFrame>();
			const chunks = yield* Queue.unbounded<string>();
			let buffer = '';
			const parser = yield* Effect.forever(
				Queue.take(chunks).pipe(
					Effect.flatMap((chunk) => {
						const lines = `${buffer}${chunk}`.split('\n');
						const remainder = lines.pop();
						if (remainder === undefined)
							return Effect.die('Terminal frame splitting lost its remainder');
						buffer = remainder;
						return Effect.forEach(
							lines.filter((line) => line.length > 0),
							(line) =>
								decodeDaemonStreamFrame(line).pipe(
									Effect.flatMap((frame) =>
										Queue.offer(
											frames,
											'requestId' in frame && 'event' in frame
												? { _tag: 'output', value: frame }
												: { _tag: 'response', value: frame },
										),
									),
								),
							{ discard: true },
						);
					}),
				),
			)
				.pipe(
					Effect.catchTag('SchemaError', (cause) =>
						Queue.offer(frames, {
							_tag: 'error',
							error: new TerminalTransportError({
								message: 'Daemon returned an invalid stream frame',
								cause,
							}),
						}),
					),
					Effect.andThen(Queue.shutdown(chunks)),
				)
				.pipe(Effect.forkScoped);
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
			socket.on('data', (chunk) => {
				Queue.offerUnsafe(chunks, chunk.toString());
			});
			socket.once('close', () => Queue.offerUnsafe(frames, { _tag: 'closed' }));
			socket.once('error', () => Queue.offerUnsafe(frames, { _tag: 'closed' }));
			return { frames, chunks, parser, socket };
		}),
		(stream) =>
			Effect.gen(function* () {
				stream.socket.destroy();
				yield* Queue.shutdown(stream.chunks);
				yield* Fiber.interrupt(stream.parser);
			}),
	);
