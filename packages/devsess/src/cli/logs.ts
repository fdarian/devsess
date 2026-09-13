import {
	Context,
	Deferred,
	Effect,
	Fiber,
	Layer,
	Queue,
	Schema,
	Semaphore,
} from 'effect';
import { FileSystem } from 'effect/FileSystem';
import { Path } from 'effect/Path';
import type { PlatformError } from 'effect/PlatformError';
import { Identifier } from './identifiers';

export const LogAddressSchema = Schema.Struct({
	runId: Identifier,
	serviceName: Identifier,
});
export type LogAddress = typeof LogAddressSchema.Type;

const NonNegativeInt = Schema.Int.check(
	Schema.makeFilter((value) => value >= 0),
);

export const LogEventSchema = Schema.Struct({
	data: Schema.String,
	offset: NonNegativeInt,
});
export type LogEvent = typeof LogEventSchema.Type;

const StoredLogSchema = Schema.fromJsonString(
	Schema.Struct({
		nextOffset: NonNegativeInt,
		events: Schema.Array(LogEventSchema),
	}),
);

const logKey = (address: LogAddress) =>
	`${address.runId}:${address.serviceName}`;

const retain = (events: Array<LogEvent>, maxBytes: number) => {
	const encoder = new TextEncoder();
	const kept = [...events];
	while (
		kept.length > 1 &&
		kept.reduce(
			(total, event) => total + encoder.encode(event.data).byteLength,
			0,
		) > maxBytes
	) {
		kept.shift();
	}
	return kept;
};

const splitData = (data: string, maxBytes: number) => {
	const encoder = new TextEncoder();
	const chunks: Array<string> = [];
	let chunk = '';
	let chunkBytes = 0;
	for (const character of data) {
		const characterBytes = encoder.encode(character).byteLength;
		if (chunk !== '' && chunkBytes + characterBytes > maxBytes) {
			chunks.push(chunk);
			chunk = '';
			chunkBytes = 0;
		}
		chunk += character;
		chunkBytes += characterBytes;
	}
	if (chunk !== '' || data === '') chunks.push(chunk);
	return chunks;
};

const writeAtomically = (target: string, content: string) =>
	Effect.gen(function* () {
		const fileSystem = yield* FileSystem;
		const path = yield* Path;
		const temporary = `${target}.${crypto.randomUUID()}.tmp`;
		yield* fileSystem.makeDirectory(path.dirname(target), { recursive: true });
		yield* fileSystem.writeFileString(temporary, content, { mode: 0o600 });
		yield* fileSystem.rename(temporary, target);
	});

export class Logs extends Context.Service<
	Logs,
	{
		readonly append: (
			address: LogAddress,
			data: string,
		) => Effect.Effect<
			LogEvent,
			PlatformError | Schema.SchemaError,
			FileSystem | Path
		>;
		readonly replayAndSubscribe: (
			address: LogAddress,
			after: number,
			listener: (event: LogEvent) => Effect.Effect<void>,
		) => Effect.Effect<
			{
				readonly replay: ReadonlyArray<LogEvent>;
				readonly flush: Effect.Effect<void>;
				readonly unsubscribe: Effect.Effect<void>;
			},
			PlatformError | Schema.SchemaError,
			FileSystem | Path
		>;
	}
>()('devsess/cli/Logs') {
	static readonly layer = (options: {
		dataDirectory: string;
		maxBytes: number;
	}) => Layer.effect(Logs, makeLogs(options));
}

const makeLogs = (options: { dataDirectory: string; maxBytes: number }) =>
	Effect.gen(function* () {
		const fileSystem = yield* FileSystem;
		const path = yield* Path;
		const semaphore = yield* Semaphore.make(1);
		const listeners = new Map<
			string,
			Set<{
				readonly listener: (event: LogEvent) => Effect.Effect<void>;
				readonly queue: Queue.Queue<{
					readonly event: LogEvent;
					readonly completion: Deferred.Deferred<void>;
				}>;
				readonly fiber: Fiber.Fiber<void, unknown>;
				readonly pending: Set<Deferred.Deferred<void>>;
				readonly flush: Effect.Effect<void>;
			}>
		>();
		const logPath = (address: LogAddress) =>
			path.join(
				options.dataDirectory,
				'logs',
				address.runId,
				`${address.serviceName}.json`,
			);
		const read = (address: LogAddress) => {
			const target = logPath(address);
			return fileSystem.exists(target).pipe(
				Effect.flatMap((exists) =>
					exists
						? fileSystem
								.readFileString(target)
								.pipe(
									Effect.flatMap(Schema.decodeUnknownEffect(StoredLogSchema)),
								)
						: Effect.succeed({
								nextOffset: 0,
								events: [] as Array<LogEvent>,
							}),
				),
			);
		};
		const append = (address: LogAddress, data: string) =>
			semaphore.withPermit(
				read(address).pipe(
					Effect.flatMap((stored) => {
						const chunks = splitData(data, options.maxBytes);
						const events = chunks.map((chunk, index) => ({
							data: chunk,
							offset:
								stored.nextOffset +
								chunks
									.slice(0, index + 1)
									.reduce(
										(total, value) =>
											total + new TextEncoder().encode(value).byteLength,
										0,
									),
						}));
						const finalEvent = events[events.length - 1];
						if (finalEvent === undefined) return Effect.die('empty log event');
						const next = {
							nextOffset: finalEvent.offset,
							events: retain([...stored.events, ...events], options.maxBytes),
						};
						const active = listeners.get(logKey(address));
						return writeAtomically(logPath(address), JSON.stringify(next)).pipe(
							Effect.andThen(
								active === undefined
									? Effect.void
									: Effect.forEach(
											active,
											(subscription) =>
												Effect.forEach(
													events,
													(event) =>
														Effect.gen(function* () {
															const completion = yield* Deferred.make<void>();
															subscription.pending.add(completion);
															if (
																Queue.offerUnsafe(subscription.queue, {
																	event,
																	completion,
																})
															)
																return;
															subscription.pending.delete(completion);
															yield* Deferred.succeed(completion, undefined);
														}),
													{ discard: true },
												),
											{ discard: true },
										),
							),
							Effect.as(finalEvent),
						);
					}),
				),
			);
		const replayAndSubscribe = (
			address: LogAddress,
			after: number,
			listener: (event: LogEvent) => Effect.Effect<void>,
		) =>
			semaphore.withPermit(
				read(address).pipe(
					Effect.flatMap((stored) =>
						Effect.gen(function* () {
							const key = logKey(address);
							const current = listeners.get(key);
							const subscribed =
								current === undefined
									? new Set<{
											readonly listener: (
												event: LogEvent,
											) => Effect.Effect<void>;
											readonly queue: Queue.Queue<{
												readonly event: LogEvent;
												readonly completion: Deferred.Deferred<void>;
											}>;
											readonly fiber: Fiber.Fiber<void, unknown>;
											readonly pending: Set<Deferred.Deferred<void>>;
											readonly flush: Effect.Effect<void>;
										}>()
									: current;
							const queue = yield* Queue.dropping<{
								readonly event: LogEvent;
								readonly completion: Deferred.Deferred<void>;
							}>(256);
							const pending = new Set<Deferred.Deferred<void>>();
							const fiber = yield* Effect.gen(function* () {
								yield* Effect.forever(
									Effect.gen(function* () {
										const item = yield* Queue.take(queue);
										yield* listener(item.event).pipe(
											Effect.ensuring(
												Effect.sync(() => {
													pending.delete(item.completion);
												}).pipe(
													Effect.andThen(
														Deferred.succeed(item.completion, undefined),
													),
												),
											),
										);
									}),
								);
							}).pipe(Effect.forkDetach);
							const flush = Effect.suspend(() =>
								Effect.forEach(
									Array.from(pending),
									(completion) => Deferred.await(completion),
									{ discard: true },
								),
							);
							const subscription = {
								listener,
								queue,
								fiber,
								pending,
								flush,
							};
							subscribed.add(subscription);
							listeners.set(key, subscribed);
							const unsubscribe = semaphore.withPermit(
								Effect.sync(() => {
									subscribed.delete(subscription);
									if (subscribed.size === 0) listeners.delete(key);
								}).pipe(
									Effect.andThen(Effect.forkDetach(Fiber.interrupt(fiber))),
								),
							);
							return {
								replay: stored.events.filter((event) => event.offset > after),
								flush,
								unsubscribe,
							};
						}),
					),
				),
			);
		return Logs.of({ append, replayAndSubscribe });
	});
