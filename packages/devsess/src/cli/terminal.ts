import { createConnection } from 'node:net';
import { StringDecoder } from 'node:string_decoder';
import { Effect, Fiber, Queue, Schema } from 'effect';
import { DaemonEvent, type DaemonRequest, DaemonResponse } from './protocol';

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
	Schema.fromJsonString(Schema.Union([DaemonResponse, DaemonEvent])),
);

/** Opens a daemon stream and preserves it until the caller's scope closes. */
export const openDaemonStream = (options: {
	socketPath: string;
	request: StreamingRequest;
}) =>
	Effect.acquireRelease(
		Effect.gen(function* () {
			const frames = yield* Queue.bounded<DaemonStreamFrame>(16);
			const chunks = yield* Queue.bounded<string>(16);
			const decoder = new StringDecoder('utf8');
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
			const offerChunk = (chunk: string) => {
				if (Queue.offerUnsafe(chunks, chunk)) return;
				socket.pause();
				Effect.runFork(
					Queue.offer(chunks, chunk).pipe(
						Effect.ensuring(
							Effect.sync(() => {
								if (!socket.destroyed) socket.resume();
							}),
						),
						Effect.catch(() => Effect.void),
					),
				);
			};
			socket.on('data', (chunk) => offerChunk(decoder.write(chunk)));
			const offerClosed = () =>
				Effect.runFork(
					Queue.offer(frames, { _tag: 'closed' }).pipe(
						Effect.catch(() => Effect.void),
					),
				);
			socket.once('close', offerClosed);
			socket.once('error', offerClosed);
			return { frames, chunks, parser, socket };
		}),
		(stream) =>
			Effect.gen(function* () {
				stream.socket.destroy();
				yield* Queue.shutdown(stream.chunks);
				yield* Queue.shutdown(stream.frames);
				yield* Fiber.interrupt(stream.parser);
			}),
	);
