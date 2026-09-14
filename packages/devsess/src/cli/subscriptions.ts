import type { Socket } from 'node:net';
import { Deferred, Effect, Fiber, Stream } from 'effect';
import type { FileSystem } from 'effect/FileSystem';
import type { Path } from 'effect/Path';
import { DaemonError } from './daemon-errors';
import type { ServiceExit } from './exit-status';
import type { LogAddress, LogsService } from './logs';
import {
	type DaemonEvent,
	type DaemonResponse,
	PROTOCOL_VERSION,
} from './protocol';
import type { SocketWriter } from './socket-writer';

type ActiveSubscription = {
	readonly flush: Effect.Effect<void>;
	readonly unsubscribe: Effect.Effect<void>;
};

export type Subscription = {
	readonly address: LogAddress;
	readonly ready: Deferred.Deferred<void>;
	active: ActiveSubscription | undefined;
	setupFiber: Fiber.Fiber<void, unknown> | undefined;
	exit: ServiceExit | undefined;
	cancelled: boolean;
	finishing: boolean;
	unsubscribed: boolean;
	unsubscribeRequested: boolean;
};

export type SocketState = {
	readonly subscriptions: Map<string, Subscription>;
	readonly writer: SocketWriter;
	closed: boolean;
};

export type Subscriptions = ReturnType<typeof makeSubscriptions>;

type CompletionRecord = {
	readonly completed: true;
	readonly exit: ServiceExit;
};

const addressKey = (address: LogAddress) =>
	`${address.runId}:${address.serviceName}`;

export const makeSubscriptions = (options: {
	readonly logs: LogsService;
	readonly sockets: Map<Socket, SocketState>;
	readonly onRelease?: (socket: Socket) => Effect.Effect<void>;
	readonly send: (
		socket: Socket,
		frame: DaemonResponse | DaemonEvent,
	) => Effect.Effect<void>;
}) => {
	const completions = new Map<string, CompletionRecord>();
	const complete = (address: LogAddress, exit: ServiceExit) => {
		const key = addressKey(address);
		const current = completions.get(key);
		if (current !== undefined) return current;
		const record: CompletionRecord = { completed: true, exit };
		completions.set(key, record);
		return record;
	};
	const removeSubscription = (
		state: SocketState,
		requestId: string,
		subscription: Subscription,
	) =>
		Effect.sync(() => {
			if (state.subscriptions.get(requestId) === subscription)
				state.subscriptions.delete(requestId);
		});
	const unsubscribeSubscription = (subscription: Subscription) =>
		Effect.suspend(() => {
			if (subscription.unsubscribed) return Effect.void;
			const active = subscription.active;
			if (active === undefined) {
				subscription.unsubscribeRequested = true;
				return Effect.void;
			}
			subscription.unsubscribed = true;
			return active.unsubscribe;
		});
	const finishSubscription = (
		socket: Socket,
		state: SocketState,
		requestId: string,
		subscription: Subscription,
		exit: ServiceExit,
	) =>
		Effect.suspend(() => {
			if (subscription.finishing) return Effect.void;
			subscription.finishing = true;
			subscription.exit = exit;
			return Deferred.await(subscription.ready).pipe(
				Effect.andThen(
					Effect.suspend(() => {
						if (state.closed || subscription.cancelled)
							return unsubscribeSubscription(subscription).pipe(
								Effect.andThen(
									removeSubscription(state, requestId, subscription),
								),
							);
						const active = subscription.active;
						if (active === undefined)
							return removeSubscription(state, requestId, subscription);
						return active.flush.pipe(
							Effect.andThen(
								options.send(socket, {
									version: PROTOCOL_VERSION,
									requestId,
									event: 'exit',
									exitCode: exit.exitCode,
									signal: exit.signal,
								}),
							),
							Effect.ensuring(
								unsubscribeSubscription(subscription).pipe(
									Effect.andThen(
										removeSubscription(state, requestId, subscription),
									),
								),
							),
						);
					}),
				),
			);
		});
	const subscribe = (
		socket: Socket,
		requestId: string,
		address: LogAddress,
		after: number,
		exit?: ServiceExit,
	) =>
		Effect.gen(function* () {
			const state = options.sockets.get(socket);
			if (state === undefined) return;
			if (state.closed)
				return yield* new DaemonError({ message: 'Socket is closed' });
			if (state.subscriptions.has(requestId))
				return yield* new DaemonError({
					message: `Subscription request id ${requestId} is already in flight`,
				});
			const ready = yield* Deferred.make<void>();
			const reservation: Subscription = {
				address,
				ready,
				active: undefined,
				setupFiber: undefined,
				exit: undefined,
				cancelled: false,
				finishing: false,
				unsubscribed: false,
				unsubscribeRequested: false,
			};
			state.subscriptions.set(requestId, reservation);
			const completion =
				exit === undefined
					? completions.get(addressKey(address))
					: complete(address, exit);
			if (completion !== undefined) reservation.exit = completion.exit;
			const listener = (event: {
				readonly data: string;
				readonly offset: number;
			}) =>
				options
					.send(socket, {
						version: PROTOCOL_VERSION,
						requestId,
						event: 'output',
						data: event.data,
						offset: event.offset,
					})
					.pipe(Effect.catch(() => Effect.void));
			const onOverflow = () =>
				state.writer
					.overflow(requestId)
					.pipe(Effect.ensuring(unsubscribeSubscription(reservation)));
			const setup = Effect.gen(function* () {
				if (state.closed || reservation.cancelled) return;
				const lazy = options.logs.replayAndSubscribeLazy;
				const subscribed =
					lazy === undefined
						? yield* options.logs.replayAndSubscribe(
								address,
								after,
								listener,
								onOverflow,
							)
						: yield* lazy(address, after, listener, onOverflow);
				reservation.active = {
					flush: subscribed.flush,
					unsubscribe: subscribed.unsubscribe,
				};
				if (
					state.closed ||
					reservation.cancelled ||
					reservation.unsubscribeRequested
				) {
					yield* unsubscribeSubscription(reservation);
					return;
				}
				yield* Deferred.succeed(reservation.ready, undefined);
				const replaySource = subscribed.replay;
				const replay: Effect.Effect<void, unknown, FileSystem | Path> =
					Array.isArray(replaySource)
						? state.writer.sendReplay(
								replaySource.map((event) => ({
									version: PROTOCOL_VERSION as 1,
									requestId,
									event: 'output' as const,
									data: event.data,
									offset: event.offset,
								})),
							)
						: state.writer.sendReplay(
								Stream.map(
									replaySource as Stream.Stream<
										{ readonly data: string; readonly offset: number },
										unknown,
										FileSystem | Path
									>,
									(event) => ({
										version: PROTOCOL_VERSION as 1,
										requestId,
										event: 'output' as const,
										data: event.data,
										offset: event.offset,
									}),
								),
							);
				yield* replay.pipe(
					Effect.ensuring(
						subscribed.completeReplay === undefined
							? Effect.void
							: subscribed.completeReplay,
					),
					Effect.catch((cause) =>
						unsubscribeSubscription(reservation).pipe(
							Effect.tap(() => Effect.logError(cause)),
						),
					),
					Effect.forkScoped,
				);
			}).pipe(
				Effect.onInterrupt(() => unsubscribeSubscription(reservation)),
				Effect.ensuring(Deferred.succeed(reservation.ready, undefined)),
			);
			const setupFiber = yield* setup.pipe(Effect.forkScoped);
			reservation.setupFiber = setupFiber;
			yield* Fiber.join(setupFiber).pipe(
				Effect.catchCause((cause) =>
					state.closed || reservation.cancelled
						? Effect.void
						: unsubscribeSubscription(reservation).pipe(
								Effect.andThen(
									removeSubscription(state, requestId, reservation),
								),
								Effect.andThen(Effect.failCause(cause)),
							),
				),
				Effect.ensuring(
					Effect.sync(() => {
						if (reservation.setupFiber === setupFiber)
							reservation.setupFiber = undefined;
					}),
				),
			);
			if (reservation.exit !== undefined) {
				const current = state.subscriptions.get(requestId);
				if (current === reservation)
					yield* finishSubscription(
						socket,
						state,
						requestId,
						reservation,
						reservation.exit,
					).pipe(Effect.forkScoped);
			}
		});
	const finishSubscriptions = (address: LogAddress, exit: ServiceExit) =>
		Effect.sync(() => complete(address, exit)).pipe(
			Effect.flatMap((completion) =>
				Effect.forEach(
					Array.from(options.sockets.entries()),
					(entry) => {
						const socket = entry[0];
						const state = entry[1];
						return Effect.forEach(
							Array.from(state.subscriptions.entries()),
							(subscriptionEntry) => {
								const requestId = subscriptionEntry[0];
								const subscription = subscriptionEntry[1];
								if (addressKey(subscription.address) !== addressKey(address))
									return Effect.void;
								return finishSubscription(
									socket,
									state,
									requestId,
									subscription,
									completion.exit,
								).pipe(Effect.forkScoped, Effect.asVoid);
							},
							{ discard: true },
						);
					},
					{ discard: true },
				),
			),
		);
	const releaseSocket = (socket: Socket) =>
		Effect.gen(function* () {
			const state = options.sockets.get(socket);
			if (state !== undefined) {
				state.closed = true;
				state.writer.close();
				const subscriptions = Array.from(state.subscriptions.values());
				state.subscriptions.clear();
				options.sockets.delete(socket);
				for (const subscription of subscriptions) {
					subscription.cancelled = true;
					yield* Deferred.succeed(subscription.ready, undefined);
					const setupFiber = subscription.setupFiber;
					if (setupFiber !== undefined)
						Effect.runFork(
							Fiber.interrupt(setupFiber).pipe(
								Effect.catchCause(() => Effect.void),
							),
						);
					yield* unsubscribeSubscription(subscription);
				}
			}
			if (options.onRelease !== undefined) yield* options.onRelease(socket);
		});
	return {
		finishSubscription,
		subscribe,
		finishSubscriptions,
		releaseSocket,
	};
};
