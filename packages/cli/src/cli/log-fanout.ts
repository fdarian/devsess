import { Deferred, Effect, Fiber, Queue } from 'effect';
import type { LogAddress, LogEvent, LogReplay } from './log-segments';

const MAX_SUBSCRIPTION_BACKLOG_BYTES = 1024 * 1024;
const MAX_SUBSCRIPTION_BACKLOG_EVENTS = 256;
const textEncoder = new TextEncoder();

type SubscriptionItem = {
	event: LogEvent;
	readonly completions: Set<Deferred.Deferred<void>>;
};

type SubscriptionRuntime = {
	tail: SubscriptionItem | undefined;
	readonly cutoff: number;
};

type ListenerSubscription = {
	readonly listener: (event: LogEvent) => Effect.Effect<void>;
	readonly onOverflow: () => Effect.Effect<void>;
	readonly queue: Queue.Queue<SubscriptionItem>;
	readonly fiber: Fiber.Fiber<void, unknown>;
	readonly pending: Set<Deferred.Deferred<void>>;
	readonly flush: Effect.Effect<void>;
	readonly runtime: SubscriptionRuntime;
	unsubscribe: Effect.Effect<void>;
	overflowed: boolean;
};

export type LogSubscription<Replay extends LogReplay = LogReplay> = {
	readonly replay: Replay;
	readonly flush: Effect.Effect<void>;
	readonly unsubscribe: Effect.Effect<void>;
	readonly completeReplay: Effect.Effect<void>;
};

export type LogFanout = {
	readonly subscribe: <Replay extends LogReplay>(
		address: LogAddress,
		replay: Replay,
		cutoff: number,
		listener: (event: LogEvent) => Effect.Effect<void>,
		onOverflow: () => Effect.Effect<void>,
	) => Effect.Effect<LogSubscription<Replay>>;
	readonly notify: (
		address: LogAddress,
		events: ReadonlyArray<LogEvent>,
	) => Effect.Effect<void>;
};

const logKey = (address: LogAddress) =>
	`${address.runId}:${address.serviceName}`;

export const makeLogFanout = (): LogFanout => {
	const listeners = new Map<string, Set<ListenerSubscription>>();
	const subscribe = <Replay extends LogReplay>(
		address: LogAddress,
		replay: Replay,
		cutoff: number,
		listener: (event: LogEvent) => Effect.Effect<void>,
		onOverflow: () => Effect.Effect<void>,
	) =>
		Effect.gen(function* () {
			const key = logKey(address);
			const current = listeners.get(key);
			const subscribed = current ?? new Set<ListenerSubscription>();
			const queue = yield* Queue.bounded<SubscriptionItem>(1);
			const pending = new Set<Deferred.Deferred<void>>();
			const replayDone = yield* Deferred.make<void>();
			const runtime: SubscriptionRuntime = {
				tail: undefined,
				cutoff,
			};
			const fiber = yield* Effect.gen(function* () {
				yield* Deferred.await(replayDone);
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
											Effect.andThen(Deferred.succeed(completion, undefined)),
										),
									{ discard: true },
								),
							),
						);
					}),
				);
			}).pipe(Effect.forkDetach);
			const flush = Effect.suspend(() =>
				Deferred.await(replayDone).pipe(
					Effect.andThen(
						Effect.forEach(
							Array.from(pending),
							(completion) => Deferred.await(completion),
							{ discard: true },
						),
					),
				),
			);
			const subscription: ListenerSubscription = {
				listener,
				onOverflow,
				queue,
				fiber,
				pending,
				flush,
				runtime,
				unsubscribe: Effect.void,
				overflowed: false,
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
			subscription.unsubscribe = unsubscribe;
			return {
				replay,
				flush,
				unsubscribe,
				completeReplay: Deferred.succeed(replayDone, undefined),
			};
		});
	const notify = (address: LogAddress, events: ReadonlyArray<LogEvent>) => {
		const key = logKey(address);
		const active = listeners.get(key);
		if (active === undefined) return Effect.void;
		return Effect.gen(function* () {
			for (const subscription of active) {
				if (subscription.overflowed) continue;
				for (const event of events) {
					if (subscription.overflowed) break;
					if (event.offset < subscription.runtime.cutoff) continue;
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
					subscription.overflowed = true;
					active.delete(subscription);
					if (active.size === 0) listeners.delete(key);
					subscription.runtime.tail = undefined;
					const pending = Array.from(subscription.pending);
					subscription.pending.clear();
					for (const pendingCompletion of pending)
						yield* Deferred.succeed(pendingCompletion, undefined);
					Effect.runFork(
						subscription.unsubscribe.pipe(
							Effect.andThen(subscription.onOverflow()),
							Effect.catchCause(() => Effect.void),
						),
					);
				}
			}
		});
	};
	return { subscribe, notify };
};
