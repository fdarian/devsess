import type { Socket } from 'node:net';
import { Effect, Stream } from 'effect';
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

export type Subscription = {
	readonly address: LogAddress;
	readonly flush: Effect.Effect<void>;
	readonly unsubscribe: Effect.Effect<void>;
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
	const finishSubscription = (
		socket: Socket,
		state: SocketState,
		requestId: string,
		subscription: Subscription,
		exit: ServiceExit,
	) =>
		subscription.flush.pipe(
			Effect.andThen(
				options.send(socket, {
					version: PROTOCOL_VERSION,
					requestId,
					event: 'exit',
					exitCode: exit.exitCode,
					signal: exit.signal,
				}),
			),
			Effect.andThen(subscription.unsubscribe),
			Effect.tap(() =>
				Effect.sync(() => {
					state.subscriptions.delete(requestId);
				}),
			),
		);
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
			const lazy = options.logs.replayAndSubscribeLazy;
			const subscribed =
				lazy === undefined
					? yield* options.logs.replayAndSubscribe(address, after, listener)
					: yield* lazy(address, after, listener);
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
			state.subscriptions.set(requestId, {
				address,
				flush: subscribed.flush,
				unsubscribe: subscribed.unsubscribe,
			});
			yield* replay.pipe(
				Effect.ensuring(
					subscribed.completeReplay === undefined
						? Effect.void
						: subscribed.completeReplay,
				),
				Effect.catch((cause) =>
					subscribed.unsubscribe.pipe(Effect.tap(() => Effect.logError(cause))),
				),
				Effect.forkScoped,
			);
			if (exit !== undefined) {
				const current = state.subscriptions.get(requestId);
				if (current !== undefined)
					yield* finishSubscription(
						socket,
						state,
						requestId,
						current,
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
					yield* subscription.unsubscribe;
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
