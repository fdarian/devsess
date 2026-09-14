import { Socket } from 'node:net';
import { describe, expect, it } from '@effect/vitest';
import { Deferred, Effect, Fiber } from 'effect';
import { vi } from 'vitest';
import { type LogAddress, type LogEvent, Logs } from '../../src/cli/logs';
import { makeSocketWriter } from '../../src/cli/socket-writer';
import {
	makeSubscriptions,
	type SocketState,
} from '../../src/cli/subscriptions';
import { runTest } from '../support/run-test';

const address: LogAddress = { runId: 'run', serviceName: 'web' };

const makeGatedLogs = (
	setupStarted: Deferred.Deferred<void>,
	releaseSetup: Deferred.Deferred<void>,
	cleanupDone: Deferred.Deferred<void>,
) => {
	let activeSubscriptions = 0;
	let unsubscribeCount = 0;
	const logs = Logs.of({
		append: (_address: LogAddress, data: string) =>
			Effect.succeed({ data, offset: data.length }),
		replayAndSubscribe: () => {
			activeSubscriptions += 1;
			let unsubscribed = false;
			const cleanup = Effect.sync(() => {
				if (unsubscribed) return;
				unsubscribed = true;
				activeSubscriptions -= 1;
				unsubscribeCount += 1;
			}).pipe(Effect.andThen(Deferred.succeed(cleanupDone, undefined)));
			return Effect.gen(function* () {
				yield* Deferred.succeed(setupStarted, undefined);
				yield* Deferred.await(releaseSetup);
				const replayDone = yield* Deferred.make<void>();
				return {
					replay: [{ data: 'replay', offset: 7 }] as Array<LogEvent>,
					flush: Deferred.await(replayDone),
					completeReplay: Deferred.succeed(replayDone, undefined),
					unsubscribe: cleanup,
				};
			}).pipe(Effect.onInterrupt(() => cleanup));
		},
	});
	return {
		logs,
		activeSubscriptions: () => activeSubscriptions,
		unsubscribeCount: () => unsubscribeCount,
	};
};

const makeSocket = () => {
	const socket = new Socket();
	const written: Array<string> = [];
	vi.spyOn(socket, 'write').mockImplementation((chunk) => {
		written.push(typeof chunk === 'string' ? chunk : chunk.toString());
		return true;
	});
	const writer = makeSocketWriter(socket, { onClose: () => undefined });
	const state: SocketState = {
		subscriptions: new Map(),
		writer,
		closed: false,
	};
	return { socket, state, written };
};

describe('subscription setup races', () => {
	it.live('finishes a tail when exit arrives during replay setup', () =>
		runTest(
			Effect.scoped(
				Effect.gen(function* () {
					const setupStarted = yield* Deferred.make<void>();
					const releaseSetup = yield* Deferred.make<void>();
					const cleanupDone = yield* Deferred.make<void>();
					const gated = makeGatedLogs(setupStarted, releaseSetup, cleanupDone);
					const configured = makeSocket();
					const sockets = new Map([[configured.socket, configured.state]]);
					const exitSent = yield* Deferred.make<void>();
					const sent: Array<string> = [];
					const subscriptions = makeSubscriptions({
						logs: gated.logs,
						sockets,
						send: (_socket, frame) =>
							Effect.sync(() => {
								if ('event' in frame) sent.push(frame.event);
								if ('event' in frame && frame.event === 'exit')
									Effect.runFork(Deferred.succeed(exitSent, undefined));
							}),
					});
					const subscribeFiber = yield* subscriptions
						.subscribe(configured.socket, 'tail', address, 0)
						.pipe(Effect.forkScoped({ startImmediately: true }));
					yield* Deferred.await(setupStarted).pipe(Effect.timeout('1 second'));
					yield* subscriptions.finishSubscriptions(address, {
						exitCode: 0,
					});
					yield* Deferred.succeed(releaseSetup, undefined);
					yield* Fiber.join(subscribeFiber);
					yield* Deferred.await(exitSent).pipe(Effect.timeout('1 second'));
					yield* Deferred.await(cleanupDone).pipe(Effect.timeout('1 second'));
					expect(gated.activeSubscriptions()).toBe(0);
					expect(gated.unsubscribeCount()).toBe(1);
					expect(
						configured.written.some((frame) =>
							frame.includes('"event":"output"'),
						),
					).toBe(true);
					expect(sent).toContain('exit');
				}),
			),
		),
	);

	it.live('cancels replay setup when the socket closes', () =>
		runTest(
			Effect.scoped(
				Effect.gen(function* () {
					const setupStarted = yield* Deferred.make<void>();
					const releaseSetup = yield* Deferred.make<void>();
					const cleanupDone = yield* Deferred.make<void>();
					const gated = makeGatedLogs(setupStarted, releaseSetup, cleanupDone);
					const configured = makeSocket();
					const sockets = new Map([[configured.socket, configured.state]]);
					const subscriptions = makeSubscriptions({
						logs: gated.logs,
						sockets,
						send: () => Effect.void,
					});
					const subscribeFiber = yield* subscriptions
						.subscribe(configured.socket, 'tail', address, 0)
						.pipe(Effect.forkScoped({ startImmediately: true }));
					yield* Deferred.await(setupStarted).pipe(Effect.timeout('1 second'));
					const releaseFiber = yield* subscriptions
						.releaseSocket(configured.socket)
						.pipe(Effect.forkScoped({ startImmediately: true }));
					expect(configured.state.closed).toBe(true);
					yield* Deferred.await(cleanupDone).pipe(Effect.timeout('1 second'));
					yield* Fiber.join(subscribeFiber).pipe(
						Effect.catchCause(() => Effect.void),
					);
					yield* Fiber.join(releaseFiber).pipe(
						Effect.catchCause(() => Effect.void),
					);
					expect(gated.activeSubscriptions()).toBe(0);
					expect(gated.unsubscribeCount()).toBe(1);
					expect(sockets.has(configured.socket)).toBe(false);
					expect(configured.state.subscriptions.size).toBe(0);
				}),
			),
		),
	);
});
