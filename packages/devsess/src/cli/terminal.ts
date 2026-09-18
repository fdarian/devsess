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

type StreamChunk =
	| { readonly _tag: 'data'; readonly data: string }
	| { readonly _tag: 'closed' };

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
			const chunks = yield* Queue.bounded<StreamChunk>(16);
			const decoder = new StringDecoder('utf8');
			let buffer = '';
			const parse = (): Effect.Effect<void, Schema.SchemaError, never> =>
				Effect.suspend(() =>
					Queue.take(chunks).pipe(
						Effect.flatMap((chunk) => {
							if (chunk._tag === 'closed')
								return Queue.offer(frames, { _tag: 'closed' });
							const lines = `${buffer}${chunk.data}`.split('\n');
							const remainder = lines.pop();
							if (remainder === undefined)
								return Effect.die(
									'Terminal frame splitting lost its remainder',
								);
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
							).pipe(Effect.andThen(parse));
						}),
					),
				);
			const parser = yield* parse()
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
			let closing = false;
			let closeQueued = false;
			let pendingChunkOffers = 0;
			const queueClosed = () => {
				if (!closing || closeQueued || pendingChunkOffers > 0) return;
				closeQueued = true;
				Effect.runFork(
					Queue.offer(chunks, { _tag: 'closed' }).pipe(
						Effect.catch(() => Effect.void),
					),
				);
			};
			const offerChunk = (chunk: string) => {
				if (closing || chunk.length === 0) return;
				const item: StreamChunk = { _tag: 'data', data: chunk };
				if (Queue.offerUnsafe(chunks, item)) return;
				pendingChunkOffers += 1;
				socket.pause();
				Effect.runFork(
					Queue.offer(chunks, item).pipe(
						Effect.ensuring(
							Effect.sync(() => {
								pendingChunkOffers -= 1;
								if (!closing && pendingChunkOffers === 0 && !socket.destroyed)
									socket.resume();
								queueClosed();
							}),
						),
						Effect.catch(() => Effect.void),
					),
				);
			};
			socket.on('data', (chunk) => offerChunk(decoder.write(chunk)));
			const offerClosed = () => {
				if (closing) return;
				closing = true;
				queueClosed();
			};
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
