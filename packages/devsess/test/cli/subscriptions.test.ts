import { Socket } from 'node:net';
import { describe, expect, it } from '@effect/vitest';
import { Deferred, Effect, Fiber } from 'effect';
import { vi } from 'vitest';
import { type LogAddress, type LogEvent, Logs } from '../../src/cli/logs';
import type { OutputWorker } from '../../src/cli/output-worker';
import type { DaemonRequest } from '../../src/cli/protocol';
import { Registry, type RunRecord } from '../../src/cli/registry';
import { makeRequestDispatcher } from '../../src/cli/request-dispatch';
import type { RunStart } from '../../src/cli/run-start';
import type { RunStop } from '../../src/cli/run-stop';
import type { ServiceStateApi } from '../../src/cli/service-state';
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
	const writer = makeSocketWriter(socket, {
		onClose: () => undefined,
		onOverflow: () => Effect.void,
	});
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
					expect(sent.filter((event) => event === 'exit')).toHaveLength(1);
					configured.state.writer.close();
					configured.socket.destroy();
				}),
			),
		),
	);

	it.live('completes a tail when the service exits before reservation', () =>
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
					yield* subscriptions.finishSubscriptions(address, {
						exitCode: 7,
						signal: 9,
					});
					const subscribeFiber = yield* subscriptions
						.subscribe(configured.socket, 'tail', address, 0)
						.pipe(Effect.forkScoped({ startImmediately: true }));
					yield* Deferred.await(setupStarted).pipe(Effect.timeout('1 second'));
					yield* Deferred.succeed(releaseSetup, undefined);
					yield* Fiber.join(subscribeFiber);
					yield* Deferred.await(exitSent).pipe(Effect.timeout('1 second'));
					yield* Deferred.await(cleanupDone).pipe(Effect.timeout('1 second'));
					expect(sent.filter((event) => event === 'exit')).toHaveLength(1);
					expect(
						configured.written.some((frame) =>
							frame.includes('"event":"output"'),
						),
					).toBe(true);
					expect(gated.unsubscribeCount()).toBe(1);
					configured.state.writer.close();
					configured.socket.destroy();
				}),
			),
		),
	);

	it.live('completes a tail after a stale registry read', () =>
		runTest(
			Effect.scoped(
				Effect.gen(function* () {
					const getStarted = yield* Deferred.make<void>();
					const allowGet = yield* Deferred.make<void>();
					const cleanupDone = yield* Deferred.make<void>();
					const configured = makeSocket();
					const sockets = new Map([[configured.socket, configured.state]]);
					const run: RunRecord = {
						runId: address.runId,
						projectName: 'project',
						presetName: 'dev',
						canonicalCwd: '/tmp',
						invocationCwd: '/tmp',
						configSnapshot: {},
						startedAt: '2026-09-09T00:00:00.000Z',
						state: 'running',
						daemon: { pid: 1234, processGroupId: 1234, startedAt: 'birth' },
						services: [
							{
								name: address.serviceName,
								command: 'sleep 30',
								cwd: '/tmp',
								state: 'running',
							},
						],
					};
					const logs = Logs.of({
						append: (_address: LogAddress, data: string) =>
							Effect.succeed({ data, offset: data.length }),
						replayAndSubscribe: (
							_address: LogAddress,
							_after: number,
							_listener: (event: LogEvent) => Effect.Effect<void>,
						) =>
							Effect.succeed({
								replay: [{ data: 'persisted', offset: 9 }] as Array<LogEvent>,
								flush: Effect.void,
								unsubscribe: Deferred.succeed(cleanupDone, undefined),
							}),
					});
					const sent: Array<string> = [];
					const exitSent = yield* Deferred.make<void>();
					const subscriptions = makeSubscriptions({
						logs,
						sockets,
						send: (_socket, frame) =>
							Effect.sync(() => {
								if ('event' in frame) sent.push(frame.event);
								if ('event' in frame && frame.event === 'exit')
									Effect.runFork(Deferred.succeed(exitSent, undefined));
							}),
					});
					const registry = Registry.of({
						get: (_runId: string) =>
							Effect.gen(function* () {
								yield* Deferred.succeed(getStarted, undefined);
								yield* Deferred.await(allowGet);
								return run;
							}),
						list: Effect.succeed([run]),
						reserve: (_run: RunRecord) => Effect.void,
						replace: (_run: RunRecord) => Effect.succeed(run),
					});
					const dispatcher = makeRequestDispatcher({
						registry,
						terminals: new Map(),
						sockets,
						output: {} as unknown as OutputWorker,
						serviceState: {} as unknown as ServiceStateApi,
						subscriptions,
						runStart: {} as unknown as RunStart,
						runStop: {} as unknown as RunStop,
						reply: () => Effect.void,
						fail: () => Effect.void,
					});
					const request: Extract<DaemonRequest, { method: 'tail' }> = {
						version: 1,
						requestId: 'tail',
						method: 'tail',
						params: { runId: address.runId, serviceName: address.serviceName },
					};
					const requestFiber = yield* dispatcher
						.processRequest(request, configured.socket)
						.pipe(Effect.forkScoped({ startImmediately: true }));
					yield* Deferred.await(getStarted).pipe(Effect.timeout('1 second'));
					yield* subscriptions.finishSubscriptions(address, {
						exitCode: 7,
						signal: 9,
					});
					yield* Deferred.succeed(allowGet, undefined);
					yield* Fiber.join(requestFiber);
					yield* Deferred.await(exitSent).pipe(Effect.timeout('1 second'));
					yield* Deferred.await(cleanupDone).pipe(Effect.timeout('1 second'));
					expect(sent.filter((event) => event === 'exit')).toHaveLength(1);
					expect(sent).toContain('exit');
					expect(
						configured.written.some((frame) => frame.includes('persisted')),
					).toBe(true);
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

	it.effect(
		'prunes persisted completion records after reservations release',
		() =>
			runTest(
				Effect.gen(function* () {
					const logs = Logs.of({
						append: (_address: LogAddress, data: string) =>
							Effect.succeed({ data, offset: 0 }),
						replayAndSubscribe: () =>
							Effect.succeed({
								replay: [] as Array<LogEvent>,
								flush: Effect.void,
								unsubscribe: Effect.void,
							}),
					});
					const subscriptions = makeSubscriptions({
						logs,
						sockets: new Map<Socket, SocketState>(),
						send: () => Effect.void,
					});
					for (let index = 0; index < 10_000; index += 1) {
						const completedAddress = {
							runId: `run-${index}`,
							serviceName: 'web',
						};
						yield* subscriptions.finishSubscriptions(completedAddress, {
							exitCode: 0,
						});
						yield* subscriptions.markPersisted(completedAddress);
					}
					expect(subscriptions.completionCount()).toBe(0);
				}),
			),
	);

	it.live('replays a late tail after completion pruning with one exit', () =>
		runTest(
			Effect.scoped(
				Effect.gen(function* () {
					const configured = makeSocket();
					const sockets = new Map([[configured.socket, configured.state]]);
					const sent: Array<string> = [];
					const exitSent = yield* Deferred.make<void>();
					const logs = Logs.of({
						append: (_address: LogAddress, data: string) =>
							Effect.succeed({ data, offset: 0 }),
						replayAndSubscribe: () =>
							Effect.succeed({
								replay: [{ data: 'persisted', offset: 0 }] as Array<LogEvent>,
								flush: Effect.void,
								unsubscribe: Effect.void,
							}),
					});
					const subscriptions = makeSubscriptions({
						logs,
						sockets,
						send: (_socket, frame) =>
							Effect.sync(() => {
								if ('event' in frame) sent.push(frame.event);
								if ('event' in frame && frame.event === 'exit')
									Effect.runFork(Deferred.succeed(exitSent, undefined));
							}),
					});
					yield* subscriptions.finishSubscriptions(address, { exitCode: 0 });
					yield* subscriptions.markPersisted(address);
					expect(subscriptions.completionCount()).toBe(0);
					yield* subscriptions.subscribe(
						configured.socket,
						'tail',
						address,
						0,
						{
							exitCode: 0,
						},
					);
					yield* Deferred.await(exitSent).pipe(Effect.timeout('1 second'));
					expect(sent.filter((event) => event === 'exit')).toHaveLength(1);
					for (let attempt = 0; attempt < 100; attempt += 1) {
						if (subscriptions.completionCount() === 0) break;
						yield* Effect.sleep('1 millis');
					}
					expect(subscriptions.completionCount()).toBe(0);
					configured.state.writer.close();
					configured.socket.destroy();
				}),
			),
		),
	);
});
