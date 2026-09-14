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
	exit: ServiceExit | undefined;
	finishing: boolean;
	unsubscribed: boolean;
};

export type SocketState = {
	readonly subscriptions: Map<string, Subscription>;
	readonly writer: SocketWriter;
};

export type Subscriptions = ReturnType<typeof makeSubscriptions>;

export const makeSubscriptions = (options: {
	readonly logs: LogsService;
	readonly sockets: Map<Socket, SocketState>;
	readonly onRelease?: (socket: Socket) => Effect.Effect<void>;
	readonly send: (
		socket: Socket,
		frame: DaemonResponse | DaemonEvent,
	) => Effect.Effect<void>;
}) => {
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
			subscription.unsubscribed = true;
			const active = subscription.active;
			return active === undefined ? Effect.void : active.unsubscribe;
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
			if (state.subscriptions.has(requestId))
				return yield* new DaemonError({
					message: `Subscription request id ${requestId} is already in flight`,
				});
			const ready = yield* Deferred.make<void>();
			const reservation: Subscription = {
				address,
				ready,
				active: undefined,
				exit,
				finishing: false,
				unsubscribed: false,
			};
			state.subscriptions.set(requestId, reservation);
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
			const setup = Effect.gen(function* () {
				const lazy = options.logs.replayAndSubscribeLazy;
				const subscribed =
					lazy === undefined
						? yield* options.logs.replayAndSubscribe(address, after, listener)
						: yield* lazy(address, after, listener);
				reservation.active = {
					flush: subscribed.flush,
					unsubscribe: subscribed.unsubscribe,
				};
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
			}).pipe(Effect.ensuring(Deferred.succeed(reservation.ready, undefined)));
			const setupFiber = yield* setup.pipe(Effect.forkScoped);
			yield* Fiber.join(setupFiber).pipe(
				Effect.catchCause((cause) =>
					unsubscribeSubscription(reservation).pipe(
						Effect.andThen(removeSubscription(state, requestId, reservation)),
						Effect.andThen(Effect.failCause(cause)),
					),
				),
			);
			if (exit !== undefined) {
				const current = state.subscriptions.get(requestId);
				if (current === reservation)
					yield* finishSubscription(
						socket,
						state,
						requestId,
						reservation,
						exit,
					).pipe(Effect.forkScoped);
			}
		});
	const finishSubscriptions = (address: LogAddress, exit: ServiceExit) =>
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
						if (
							`${subscription.address.runId}:${subscription.address.serviceName}` !==
							`${address.runId}:${address.serviceName}`
						)
							return Effect.void;
						return finishSubscription(
							socket,
							state,
							requestId,
							subscription,
							exit,
						).pipe(Effect.forkScoped, Effect.asVoid);
					},
					{ discard: true },
				);
			},
			{ discard: true },
		);
	const releaseSocket = (socket: Socket) =>
		Effect.gen(function* () {
			const state = options.sockets.get(socket);
			if (state !== undefined) {
				state.writer.close();
				for (const subscription of state.subscriptions.values())
					yield* unsubscribeSubscription(subscription);
				state.subscriptions.clear();
				options.sockets.delete(socket);
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
