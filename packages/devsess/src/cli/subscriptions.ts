import type { Socket } from 'node:net';
import { Effect } from 'effect';
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
			const subscription = yield* options.logs.replayAndSubscribe(
				address,
				after,
				(event) =>
					options
						.send(socket, {
							version: PROTOCOL_VERSION,
							requestId,
							event: 'output',
							data: event.data,
							offset: event.offset,
						})
						.pipe(Effect.catch(() => Effect.void)),
			);
			yield* state.writer.sendReplay(
				subscription.replay.map((event) => ({
					version: PROTOCOL_VERSION,
					requestId,
					event: 'output' as const,
					data: event.data,
					offset: event.offset,
				})),
			);
			state.subscriptions.set(requestId, {
				address,
				flush: subscription.flush,
				unsubscribe: subscription.unsubscribe,
			});
			if (exit !== undefined) {
				const current = state.subscriptions.get(requestId);
				if (current !== undefined)
					yield* finishSubscription(socket, state, requestId, current, exit);
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
						);
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
