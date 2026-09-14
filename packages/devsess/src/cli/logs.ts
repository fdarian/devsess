import {
	Context,
	Deferred,
	Effect,
	Fiber,
	Layer,
	Queue,
	Schema,
	Semaphore,
	Stream,
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

const LogLineSchema = Schema.fromJsonString(LogEventSchema);
const textEncoder = new TextEncoder();
const MAX_SUBSCRIPTION_BACKLOG_BYTES = 1024 * 1024;
const MAX_SUBSCRIPTION_BACKLOG_EVENTS = 256;

const isUtf8Continuation = (value: number) => (value & 0xc0) === 0x80;
const utf8Width = (value: number) =>
	value < 0x80 ? 1 : value < 0xe0 ? 2 : value < 0xf0 ? 3 : 4;

type Segment = {
	readonly events: Array<LogEvent>;
	readonly bytes: number;
	readonly exists: boolean;
	readonly partial: boolean;
};

type LogState = {
	nextOffset: number;
	currentBytes: number;
	currentExists: boolean;
	currentPartial: boolean;
};

type SubscriptionItem = {
	event: LogEvent;
	readonly completions: Set<Deferred.Deferred<void>>;
};

type SubscriptionRuntime = {
	tail: SubscriptionItem | undefined;
};

type ListenerSubscription = {
	readonly listener: (event: LogEvent) => Effect.Effect<void>;
	readonly queue: Queue.Queue<SubscriptionItem>;
	readonly fiber: Fiber.Fiber<void, unknown>;
	readonly pending: Set<Deferred.Deferred<void>>;
	readonly flush: Effect.Effect<void>;
	readonly runtime: SubscriptionRuntime;
};

const logKey = (address: LogAddress) =>
	`${address.runId}:${address.serviceName}`;

const splitData = (data: string, maxBytes: number) => {
	const encoded = textEncoder.encode(data);
	const chunks: Array<string> = [];
	if (encoded.byteLength === 0) return [''];
	let offset = 0;
	while (offset < encoded.byteLength) {
		let end = Math.min(offset + maxBytes, encoded.byteLength);
		if (end < encoded.byteLength && isUtf8Continuation(encoded[end] ?? 0)) {
			let codePointStart = end - 1;
			while (
				codePointStart > offset &&
				isUtf8Continuation(encoded[codePointStart] ?? 0)
			)
				codePointStart -= 1;
			end = Math.min(
				codePointStart + utf8Width(encoded[codePointStart] ?? 0),
				encoded.byteLength,
			);
		}
		chunks.push(Buffer.from(encoded.subarray(offset, end)).toString('utf8'));
		offset = end;
	}
	return chunks;
};

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
		readonly replayAndSubscribeLazy?: (
			address: LogAddress,
			after: number,
			listener: (event: LogEvent) => Effect.Effect<void>,
		) => Effect.Effect<
			{
				readonly replay: Stream.Stream<
					LogEvent,
					PlatformError | Schema.SchemaError,
					FileSystem | Path
				>;
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
		const states = new Map<string, LogState>();
		const listeners = new Map<string, Set<ListenerSubscription>>();
		const logBase = (address: LogAddress) =>
			path.join(
				options.dataDirectory,
				'logs',
				address.runId,
				address.serviceName,
			);
		const currentPath = (address: LogAddress) => `${logBase(address)}.jsonl`;
		const previousPath = (address: LogAddress) => `${logBase(address)}.1.jsonl`;

		const decodeLine = (
			line: string,
		): Effect.Effect<LogEvent, Schema.SchemaError> =>
			Schema.decodeUnknownEffect(LogLineSchema)(line);
		const decodeLines = (content: string) => {
			const lines = content.split('\n');
			lines.pop();
			const complete = lines.filter((line) => line.length > 0);
			return Effect.forEach(complete, decodeLine, { discard: false });
		};
		const readSegment = (
			target: string,
		): Effect.Effect<Segment, PlatformError | Schema.SchemaError> =>
			fileSystem.exists(target).pipe(
				Effect.flatMap((exists) =>
					exists
						? fileSystem.readFileString(target).pipe(
								Effect.flatMap((content) =>
									decodeLines(content).pipe(
										Effect.map((events) => ({
											events,
											bytes: textEncoder.encode(content).byteLength,
											exists: true as boolean,
											partial: !content.endsWith('\n'),
										})),
									),
								),
							)
						: Effect.succeed({
								events: [] as Array<LogEvent>,
								bytes: 0,
								exists: false as boolean,
								partial: false,
							}),
				),
			);
		const readSegments = (address: LogAddress) =>
			Effect.all({
				previous: readSegment(previousPath(address)),
				current: readSegment(currentPath(address)),
			});
		const completeLines = function* (content: string) {
			let start = 0;
			for (let index = 0; index < content.length; index += 1) {
				if (content[index] !== '\n') continue;
				const line = content.slice(start, index);
				if (line.length > 0) yield line;
				start = index + 1;
			}
		};
		const readSegmentStream = (target: string) =>
			Stream.fromEffect(fileSystem.exists(target)).pipe(
				Stream.flatMap((exists) =>
					exists
						? Stream.fromEffect(fileSystem.readFileString(target)).pipe(
								Stream.flatMap((content) =>
									Stream.fromIteratorSucceed(completeLines(content)),
								),
							)
						: Stream.empty,
				),
				Stream.mapEffect((line) => decodeLine(line)),
			);
		const replayStream = (address: LogAddress, after: number) =>
			readSegmentStream(previousPath(address)).pipe(
				Stream.concat(readSegmentStream(currentPath(address))),
				Stream.filter((event) => event.offset > after),
			);
		const loadState = (address: LogAddress) => {
			const key = logKey(address);
			const existing = states.get(key);
			if (existing !== undefined) return Effect.succeed(existing);
			return readSegments(address).pipe(
				Effect.map((segments) => {
					const allEvents = [
						...segments.previous.events,
						...segments.current.events,
					];
					const last = allEvents[allEvents.length - 1];
					const state: LogState = {
						nextOffset: last === undefined ? 0 : last.offset,
						currentBytes: segments.current.bytes,
						currentExists: segments.current.exists,
						currentPartial: segments.current.partial,
					};
					states.set(key, state);
					return state;
				}),
			);
		};
		const rotate = (address: LogAddress, state: LogState) => {
			const current = currentPath(address);
			const previous = previousPath(address);
			return fileSystem
				.makeDirectory(path.dirname(current), { recursive: true })
				.pipe(
					Effect.andThen(
						state.currentExists
							? fileSystem.rename(current, previous)
							: Effect.void,
					),
					Effect.tap(() =>
						Effect.sync(() => {
							state.currentBytes = 0;
							state.currentExists = false;
							state.currentPartial = false;
						}),
					),
				);
		};
		const appendLine = (
			address: LogAddress,
			state: LogState,
			event: LogEvent,
		) => {
			const target = currentPath(address);
			const line = `${JSON.stringify(event)}\n`;
			const lineBytes = textEncoder.encode(line).byteLength;
			const needsRotation =
				state.currentPartial ||
				(state.currentExists &&
					state.currentBytes + lineBytes > options.maxBytes);
			const beforeWrite = needsRotation ? rotate(address, state) : Effect.void;
			return beforeWrite.pipe(
				Effect.andThen(
					fileSystem.makeDirectory(path.dirname(target), { recursive: true }),
				),
				Effect.andThen(
					fileSystem.writeFileString(target, line, {
						flag: 'a',
						mode: 0o600,
					}),
				),
				Effect.tap(() =>
					Effect.sync(() => {
						state.currentBytes += lineBytes;
						state.currentExists = true;
						state.currentPartial = false;
					}),
				),
			);
		};
		const notify = (address: LogAddress, events: ReadonlyArray<LogEvent>) => {
			const active = listeners.get(logKey(address));
			if (active === undefined) return Effect.void;
			return Effect.gen(function* () {
				for (const subscription of active) {
					for (const event of events) {
						const completion = yield* Deferred.make<void>();
						subscription.pending.add(completion);
						const item: SubscriptionItem = {
							event,
							completions: new Set([completion]),
						};
						if (Queue.offerUnsafe(subscription.queue, item)) {
							subscription.runtime.tail = item;
							continue;
						}
						const tail = subscription.runtime.tail;
						if (
							tail !== undefined &&
							tail.completions.size < MAX_SUBSCRIPTION_BACKLOG_EVENTS &&
							textEncoder.encode(tail.event.data).byteLength +
								textEncoder.encode(event.data).byteLength <=
								MAX_SUBSCRIPTION_BACKLOG_BYTES
						) {
							tail.event = {
								data: tail.event.data + event.data,
								offset: event.offset,
							};
							tail.completions.add(completion);
							continue;
						}
						subscription.runtime.tail = item;
						yield* Queue.offer(subscription.queue, item).pipe(
							Effect.catch(() =>
								Effect.sync(() => {
									if (subscription.runtime.tail === item)
										subscription.runtime.tail = undefined;
									subscription.pending.delete(completion);
								}).pipe(
									Effect.andThen(Deferred.succeed(completion, undefined)),
								),
							),
						);
					}
				}
			});
		};
		const append = (address: LogAddress, data: string) =>
			semaphore.withPermit(
				loadState(address).pipe(
					Effect.flatMap((state) => {
						const chunks = splitData(data, options.maxBytes);
						const events: Array<LogEvent> = [];
						let nextOffset = state.nextOffset;
						for (const chunk of chunks) {
							nextOffset += textEncoder.encode(chunk).byteLength;
							events.push({ data: chunk, offset: nextOffset });
						}
						const finalEvent = events[events.length - 1];
						if (finalEvent === undefined) return Effect.die('empty log event');
						return Effect.forEach(
							events,
							(event) => appendLine(address, state, event),
							{
								discard: true,
							},
						).pipe(
							Effect.tap(() =>
								Effect.sync(() => {
									state.nextOffset = finalEvent.offset;
								}),
							),
							Effect.andThen(notify(address, events)),
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
				readSegments(address).pipe(
					Effect.flatMap((segments) =>
						Effect.gen(function* () {
							const key = logKey(address);
							const current = listeners.get(key);
							const subscribed = current ?? new Set<ListenerSubscription>();
							const queue = yield* Queue.bounded<SubscriptionItem>(1);
							const pending = new Set<Deferred.Deferred<void>>();
							const runtime: SubscriptionRuntime = { tail: undefined };
							const fiber = yield* Effect.gen(function* () {
								yield* Effect.forever(
									Effect.gen(function* () {
										const item = yield* Queue.take(queue);
										runtime.tail = undefined;
										yield* listener(item.event).pipe(
											Effect.ensuring(
												Effect.forEach(
													Array.from(item.completions),
													(completion) =>
														Effect.sync(() => {
															pending.delete(completion);
														}).pipe(
															Effect.andThen(
																Deferred.succeed(completion, undefined),
															),
														),
													{ discard: true },
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
							const subscription: ListenerSubscription = {
								listener,
								queue,
								fiber,
								pending,
								flush,
								runtime,
							};
							subscribed.add(subscription);
							listeners.set(key, subscribed);
							const unsubscribe = Effect.sync(() => {
								subscribed.delete(subscription);
								if (subscribed.size === 0) listeners.delete(key);
							}).pipe(
								Effect.andThen(Queue.shutdown(queue)),
								Effect.andThen(Effect.forkDetach(Fiber.interrupt(fiber))),
							);
							return {
								replay: [
									...segments.previous.events,
									...segments.current.events,
								].filter((event) => event.offset > after),
								flush,
								unsubscribe,
							};
						}),
					),
				),
			);
		const replayAndSubscribeLazy = (
			address: LogAddress,
			after: number,
			listener: (event: LogEvent) => Effect.Effect<void>,
		) =>
			semaphore.withPermit(
				Effect.gen(function* () {
					const key = logKey(address);
					const current = listeners.get(key);
					const subscribed = current ?? new Set<ListenerSubscription>();
					const queue = yield* Queue.bounded<SubscriptionItem>(1);
					const pending = new Set<Deferred.Deferred<void>>();
					const runtime: SubscriptionRuntime = { tail: undefined };
					const fiber = yield* Effect.gen(function* () {
						yield* Effect.forever(
							Effect.gen(function* () {
								const item = yield* Queue.take(queue);
								runtime.tail = undefined;
								yield* listener(item.event).pipe(
									Effect.ensuring(
										Effect.forEach(
											Array.from(item.completions),
											(completion) =>
												Effect.sync(() => {
													pending.delete(completion);
												}).pipe(
													Effect.andThen(
														Deferred.succeed(completion, undefined),
													),
												),
											{ discard: true },
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
					const subscription: ListenerSubscription = {
						listener,
						queue,
						fiber,
						pending,
						flush,
						runtime,
					};
					subscribed.add(subscription);
					listeners.set(key, subscribed);
					const unsubscribe = Effect.sync(() => {
						subscribed.delete(subscription);
						if (subscribed.size === 0) listeners.delete(key);
					}).pipe(
						Effect.andThen(Queue.shutdown(queue)),
						Effect.andThen(Effect.forkDetach(Fiber.interrupt(fiber))),
					);
					return {
						replay: replayStream(address, after),
						flush,
						unsubscribe,
					};
				}),
			);
		return Logs.of({
			append,
			replayAndSubscribe,
			replayAndSubscribeLazy,
		});
	});

export type LogsService = Context.Service.Shape<typeof Logs>;
