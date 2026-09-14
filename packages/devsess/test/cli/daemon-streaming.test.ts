import { createConnection } from 'node:net';
import { join } from 'node:path';
import { describe, expect, it } from '@effect/vitest';
import { Deferred, Effect, Layer } from 'effect';
import { FileSystem } from 'effect/FileSystem';
import { Daemon, makeDaemon } from '../../src/cli/daemon';
import { Logs } from '../../src/cli/logs';
import { Processes } from '../../src/cli/processes';
import type { DaemonRequest } from '../../src/cli/protocol';
import { Registry, type RunRecord } from '../../src/cli/registry';
import { runTest } from '../support/run-test';
import { makeTempDir } from '../support/temp-dir';

const startRequest = (
	runId: string,
	command = `${process.execPath} -e 'process.stdout.write("x".repeat(32 * 1024 * 1024)); process.stdout.write("FINAL"); setTimeout(() => {}, 30000)'`,
): DaemonRequest => ({
	version: 1,
	requestId: `start-${runId}`,
	method: 'startRun',
	params: {
		runId,
		projectName: 'project',
		presetName: 'dev',
		canonicalCwd: '/tmp',
		invocationCwd: '/tmp',
		configSnapshot: {},
		environment: {},
		services: [
			{
				name: 'web',
				command,
				cwd: '/tmp',
			},
		],
	},
});

const tailRequest = (runId: string): DaemonRequest => ({
	version: 1,
	requestId: `tail-${runId}`,
	method: 'tail',
	params: { runId, serviceName: 'web' },
});

const listRequest: DaemonRequest = {
	version: 1,
	requestId: 'list',
	method: 'listRuns',
	params: {},
};

const waitForConnection = (socket: ReturnType<typeof createConnection>) =>
	Effect.tryPromise({
		try: () =>
			new Promise<void>((resolve, reject) => {
				socket.once('error', reject);
				socket.once('connect', resolve);
			}),
		catch: (cause) => cause,
	});

describe('daemon streaming integration', () => {
	it.live('drains output before stop completes and sends the final chunk', () =>
		runTest(
			Effect.gen(function* () {
				const root = yield* makeTempDir;
				const socketPath = join(root, 'daemon.sock');
				const dependencies = Layer.mergeAll(
					Registry.layer({ dataDirectory: root }),
					Logs.layer({ dataDirectory: root, maxBytes: 1024 * 1024 }),
					Processes.layer,
				);
				const daemonLayer = Layer.effect(
					Daemon,
					makeDaemon({ socketPath }),
				).pipe(Layer.provideMerge(dependencies));
				yield* Effect.gen(function* () {
					const daemon = yield* Daemon;
					const readyPath = join(root, 'stop-drain.ready');
					yield* daemon.request(
						startRequest(
							'stop-drain',
							`${process.execPath} -e 'const fs = require("node:fs"); process.stdout.write("x".repeat(32 * 1024 * 1024)); process.stdout.write("FINAL"); fs.writeFileSync(${JSON.stringify(readyPath)}, "ready"); setTimeout(() => {}, 30000)'`,
						),
					);
					const socket = yield* Effect.acquireRelease(
						Effect.sync(() => createConnection(socketPath)),
						(socket) => Effect.sync(() => socket.destroy()),
					);
					yield* waitForConnection(socket);
					const receivedChunks: Array<string> = [];
					let remainder = '';
					let tailReady = false;
					let tailDone = false;
					const ready = yield* Deferred.make<void>();
					const outputReady = yield* Deferred.make<void>();
					const finished = yield* Deferred.make<void>();
					socket.on('data', (chunk) => {
						const text = chunk.toString();
						receivedChunks.push(text);
						const frames = `${remainder}${text}`.split('\n');
						const nextRemainder = frames.pop();
						if (nextRemainder === undefined) return;
						remainder = nextRemainder;
						for (const frame of frames) {
							if (frame.length === 0) continue;
							const value = JSON.parse(frame) as {
								ok?: boolean;
								event?: string;
								data?: string;
							};
							if (value.ok === true) {
								tailReady = true;
								Effect.runFork(Deferred.succeed(ready, undefined));
							}
							if (value.event === 'exit') {
								tailDone = true;
								Effect.runFork(Deferred.succeed(finished, undefined));
							}
							if (value.data?.includes('FINAL') === true)
								Effect.runFork(Deferred.succeed(outputReady, undefined));
						}
					});
					socket.write(`${JSON.stringify(tailRequest('stop-drain'))}\n`);
					yield* Deferred.await(ready).pipe(Effect.timeout('2 seconds'));
					const fileSystem = yield* FileSystem;
					let emitted = false;
					for (let attempt = 0; attempt < 150; attempt += 1) {
						if (yield* fileSystem.exists(readyPath)) {
							emitted = true;
							break;
						}
						yield* Effect.sleep('20 millis');
					}
					expect(emitted).toBe(true);
					yield* daemon.request({
						version: 1,
						requestId: 'stop',
						method: 'stopRun',
						params: { runId: 'stop-drain' },
					} as DaemonRequest);
					yield* Deferred.await(outputReady).pipe(Effect.timeout('30 seconds'));
					yield* Deferred.await(finished).pipe(Effect.timeout('5 seconds'));
					expect(tailReady).toBe(true);
					expect(tailDone).toBe(true);
					expect(receivedChunks.join('')).toContain('FINAL');
					const logs = yield* Logs;
					const replay = yield* logs.replayAndSubscribe(
						{ runId: 'stop-drain', serviceName: 'web' },
						0,
						() => Effect.void,
					);
					yield* replay.unsubscribe;
					expect(replay.replay.map((event) => event.data).join('')).toContain(
						'FINAL',
					);
				}).pipe(Effect.provide(daemonLayer));
			}),
		),
	);

	it.live('keeps list responsive while a completed replay is paused', () =>
		runTest(
			Effect.gen(function* () {
				const root = yield* makeTempDir;
				const socketPath = join(root, 'daemon.sock');
				const dependencies = Layer.mergeAll(
					Registry.layer({ dataDirectory: root }),
					Logs.layer({ dataDirectory: root, maxBytes: 1024 * 1024 }),
					Processes.layer,
				);
				const daemonLayer = Layer.effect(
					Daemon,
					makeDaemon({ socketPath }),
				).pipe(Layer.provideMerge(dependencies));
				yield* Effect.scoped(
					Effect.gen(function* () {
						const daemon = yield* Daemon;
						yield* daemon.request(
							startRequest(
								'completed-replay',
								`${process.execPath} -e 'process.stdout.write("x".repeat(1024 * 1024))'`,
							),
						);
						let completed = false;
						for (let attempt = 0; attempt < 100; attempt += 1) {
							const runs = (yield* daemon.request(
								listRequest,
							)) as Array<RunRecord>;
							if (
								runs.some(
									(run) =>
										run.runId === 'completed-replay' && run.state === 'exited',
								)
							) {
								completed = true;
								break;
							}
							yield* Effect.sleep('20 millis');
						}
						expect(completed).toBe(true);
						const socket = yield* Effect.acquireRelease(
							Effect.sync(() => createConnection(socketPath)),
							(socket) => Effect.sync(() => socket.destroy()),
						);
						yield* waitForConnection(socket);
						socket.write(
							`${JSON.stringify(tailRequest('completed-replay'))}\n`,
						);
						socket.pause();
						const started = performance.now();
						const runs = yield* daemon
							.request(listRequest)
							.pipe(Effect.timeout('1 second'));
						const latency = performance.now() - started;
						expect(runs).toHaveLength(1);
						expect(latency).toBeLessThan(500);
					}).pipe(Effect.provide(daemonLayer)),
				);
			}),
		),
	);

	it.live(
		'backpressures flooded RPCs without dropping lifecycle completion',
		() =>
			runTest(
				Effect.gen(function* () {
					const root = yield* makeTempDir;
					const socketPath = join(root, 'daemon.sock');
					const dependencies = Layer.mergeAll(
						Registry.layer({ dataDirectory: root }),
						Logs.layer({ dataDirectory: root, maxBytes: 1024 * 1024 }),
						Processes.layer,
					);
					const daemonLayer = Layer.effect(
						Daemon,
						makeDaemon({ socketPath }),
					).pipe(Layer.provideMerge(dependencies));
					yield* Effect.scoped(
						Effect.gen(function* () {
							const daemon = yield* Daemon;
							yield* daemon.request(
								startRequest(
									'flood-lifecycle',
									'sleep 0.2; printf DONE; sleep 0.2',
								),
							);
							const tail = yield* Effect.acquireRelease(
								Effect.sync(() => createConnection(socketPath)),
								(socket) => Effect.sync(() => socket.destroy()),
							);
							yield* waitForConnection(tail);
							const tailDone = yield* Deferred.make<void>();
							let tailRemainder = '';
							tail.on('data', (chunk) => {
								const frames = `${tailRemainder}${chunk.toString()}`.split(
									'\n',
								);
								const nextRemainder = frames.pop();
								if (nextRemainder === undefined) return;
								tailRemainder = nextRemainder;
								for (const frame of frames) {
									if (frame.length === 0) continue;
									const value = JSON.parse(frame) as { event?: string };
									if (value.event === 'exit')
										Effect.runFork(Deferred.succeed(tailDone, undefined));
								}
							});
							tail.write(`${JSON.stringify(tailRequest('flood-lifecycle'))}\n`);
							const flood = yield* Effect.acquireRelease(
								Effect.sync(() => createConnection(socketPath)),
								(socket) => Effect.sync(() => socket.destroy()),
							);
							yield* waitForConnection(flood);
							const floodDone = yield* Deferred.make<void>();
							const responseIds = new Set<string>();
							let floodRemainder = '';
							flood.on('data', (chunk) => {
								const frames = `${floodRemainder}${chunk.toString()}`.split(
									'\n',
								);
								const nextRemainder = frames.pop();
								if (nextRemainder === undefined) return;
								floodRemainder = nextRemainder;
								for (const frame of frames) {
									if (frame.length === 0) continue;
									const value = JSON.parse(frame) as {
										requestId?: string;
										ok?: boolean;
										error?: string;
									};
									if (value.requestId === undefined) continue;
									responseIds.add(value.requestId);
									if (responseIds.size === 300)
										Effect.runFork(Deferred.succeed(floodDone, undefined));
									if (value.ok === false) expect(value.error).toBeDefined();
								}
							});
							const requests = Array.from({ length: 300 }, (_value, index) => ({
								...listRequest,
								requestId: `flood-${index}`,
							}));
							flood.write(
								`${requests.map((request) => JSON.stringify(request)).join('\n')}\n`,
							);
							yield* Deferred.await(floodDone).pipe(
								Effect.timeout('3 seconds'),
							);
							yield* Deferred.await(tailDone).pipe(Effect.timeout('3 seconds'));
							expect(responseIds.size).toBe(300);
						}).pipe(Effect.provide(daemonLayer)),
					);
				}),
			),
	);
});
