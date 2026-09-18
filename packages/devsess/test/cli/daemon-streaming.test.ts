import { spawn } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { createConnection } from 'node:net';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from '@effect/vitest';
import { Deferred, Effect, Fiber, Layer } from 'effect';
import { FileSystem } from 'effect/FileSystem';
import { callDaemon } from '../../src/cli/client';
import { Daemon, makeDaemon } from '../../src/cli/daemon';
import { Logs } from '../../src/cli/logs';
import { Processes } from '../../src/cli/processes';
import {
	type DaemonRequest,
	LIVE_OUTPUT_OVERFLOW_MESSAGE,
} from '../../src/cli/protocol';
import { spawnPty } from '../../src/cli/pty';
import { Registry, type RunRecord } from '../../src/cli/registry';
import { runTest } from '../support/run-test';
import { makeTempDir } from '../support/temp-dir';

const startRequest = (
	runId: string,
	command = `${process.execPath} -e 'process.stdout.write("x".repeat(32 * 1024 * 1024)); process.stdout.write("FINAL"); setTimeout(() => {}, 30000)'`,
	cwd = '/tmp',
	canonicalCwd = cwd,
): DaemonRequest => ({
	version: 1,
	requestId: `start-${runId}`,
	method: 'startRun',
	params: {
		runId,
		projectName: 'project',
		presetName: 'dev',
		canonicalCwd,
		invocationCwd: cwd,
		configSnapshot: {},
		environment: {},
		services: [
			{
				name: 'web',
				command,
				cwd,
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

const attachRequest = (runId: string, requestId: string): DaemonRequest => ({
	version: 1,
	requestId,
	method: 'attach',
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

const cliPath = fileURLToPath(new URL('../../dist/cli.js', import.meta.url));

type TailClient = {
	readonly child: ReturnType<typeof spawn>;
	readonly pid: number;
	readonly ready: Deferred.Deferred<void, Error>;
	readonly closed: Deferred.Deferred<
		{
			readonly exitCode: number | null;
			readonly signal: NodeJS.Signals | null;
		},
		Error
	>;
	readonly output: () => string;
};

const startTailClient = (options: {
	readonly cwd: string;
	readonly stateHome: string;
	readonly runtimeDirectory: string;
}) =>
	Effect.gen(function* () {
		const ready = yield* Deferred.make<void, Error>();
		const closed = yield* Deferred.make<
			{
				readonly exitCode: number | null;
				readonly signal: NodeJS.Signals | null;
			},
			Error
		>();
		const child = yield* Effect.try({
			try: () =>
				spawn(process.execPath, [cliPath, 'tail'], {
					cwd: options.cwd,
					env: {
						...process.env,
						XDG_STATE_HOME: options.stateHome,
						XDG_RUNTIME_DIR: options.runtimeDirectory,
					},
					stdio: ['ignore', 'pipe', 'pipe'],
				}),
			catch: (cause) =>
				new Error('Could not start the devsess tail client', { cause }),
		});
		const pid = child.pid;
		if (pid === undefined)
			return yield* Effect.die('Tail client did not receive a process ID');
		const stdout = child.stdout;
		if (stdout === null)
			return yield* Effect.die('Tail client stdout was not piped');
		const stderr = child.stderr;
		if (stderr === null)
			return yield* Effect.die('Tail client stderr was not piped');
		const messages: Array<string> = [];
		stdout.on('data', (chunk) => {
			const text = chunk.toString();
			messages.push(text);
			if (!text.includes('TAIL_READY')) return;
			Effect.runFork(Deferred.succeed(ready, undefined));
		});
		stderr.on('data', (chunk) => {
			messages.push(chunk.toString());
		});
		child.once('error', (cause) => {
			Effect.runFork(Deferred.fail(ready, cause));
			Effect.runFork(Deferred.fail(closed, cause));
		});
		child.once('close', (exitCode, signal) => {
			Effect.runFork(Deferred.succeed(closed, { exitCode, signal }));
		});
		return {
			child,
			pid,
			ready,
			closed,
			output: () => messages.join(''),
		};
	});

const stopTailClient = (client: TailClient) =>
	Effect.sync(() => {
		if (client.child.exitCode !== null) return;
		client.child.kill('SIGCONT');
		client.child.kill('SIGKILL');
	});

type AttachClient = {
	readonly pid: number;
	readonly ready: Deferred.Deferred<void, Error>;
	readonly closed: Deferred.Deferred<{ readonly exitCode: number }, Error>;
	readonly output: () => string;
	readonly exited: () => boolean;
};

const startAttachClient = (options: {
	readonly cwd: string;
	readonly stateHome: string;
	readonly runtimeDirectory: string;
}) =>
	Effect.gen(function* () {
		const ready = yield* Deferred.make<void, Error>();
		const closed = yield* Deferred.make<{ readonly exitCode: number }, Error>();
		const terminal = yield* spawnPty({
			command: process.execPath,
			args: [cliPath, 'attach'],
			cwd: options.cwd,
			env: {
				...process.env,
				XDG_STATE_HOME: options.stateHome,
				XDG_RUNTIME_DIR: options.runtimeDirectory,
			},
			cols: 80,
			rows: 24,
		});
		const messages: Array<string> = [];
		let exited = false;
		const output = () => messages.join('');
		terminal.onData((data) => {
			messages.push(data);
			if (output().includes('Press Ctrl-] to detach'))
				Effect.runFork(Deferred.succeed(ready, undefined));
		});
		terminal.onExit((exit) => {
			exited = true;
			Effect.runFork(Deferred.succeed(closed, { exitCode: exit.exitCode }));
			Effect.runFork(
				Deferred.fail(
					ready,
					new Error('Attached client exited before acquiring its input lease'),
				),
			);
		});
		return {
			pid: terminal.pid,
			ready,
			closed,
			output,
			exited: () => exited,
		};
	});

const stopAttachClient = (client: AttachClient) =>
	Effect.sync(() => {
		if (client.exited()) return;
		process.kill(client.pid, 'SIGCONT');
		process.kill(client.pid, 'SIGKILL');
	});

const attachUntilSuccessful = (
	socketPath: string,
	runId: string,
	attempt = 0,
): Effect.Effect<unknown> =>
	callDaemon(
		socketPath,
		attachRequest(runId, `replacement-${attempt}`),
		250,
	).pipe(
		Effect.catch(() =>
			Effect.sleep('10 millis').pipe(
				Effect.andThen(attachUntilSuccessful(socketPath, runId, attempt + 1)),
			),
		),
	);

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

	it.live('stops a burst with a paused tail without blocking persistence', () =>
		runTest(
			Effect.gen(function* () {
				const root = yield* makeTempDir;
				const socketPath = join(root, 'daemon.sock');
				const gatePath = join(root, 'emit.ready');
				const outputReadyPath = join(root, 'output.ready');
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
						const command = `${process.execPath} -e 'const fs=require("node:fs"); const gate=${JSON.stringify(gatePath)}; const outputReady=${JSON.stringify(outputReadyPath)}; const timer=setInterval(() => { if (fs.existsSync(gate)) { clearInterval(timer); process.stdout.write("x".repeat(8 * 1024 * 1024)); process.stdout.write("FINAL"); fs.writeFileSync(outputReady, "ready"); setTimeout(() => {}, 30000); } }, 5)'`;
						yield* daemon.request(startRequest('paused-stop', command));
						const tail = yield* Effect.acquireRelease(
							Effect.sync(() => createConnection(socketPath)),
							(socket) => Effect.sync(() => socket.destroy()),
						);
						yield* waitForConnection(tail);
						let remainder = '';
						let tailReady = false;
						let tailClosed = false;
						let tailExit = false;
						let overflowFrame = false;
						const tailRequestValue = tailRequest('paused-stop');
						tail.on('error', () => undefined);
						tail.once('close', () => {
							tailClosed = true;
						});
						tail.on('data', (chunk) => {
							const frames = `${remainder}${chunk.toString()}`.split('\n');
							const nextRemainder = frames.pop();
							if (nextRemainder === undefined) return;
							remainder = nextRemainder;
							for (const frame of frames) {
								if (frame.length === 0) continue;
								const value = JSON.parse(frame) as {
									requestId?: string;
									ok?: boolean;
									error?: string;
									event?: string;
								};
								if (value.requestId !== tailRequestValue.requestId) continue;
								if (value.ok === true) {
									tailReady = true;
									tail.pause();
								}
								if (value.event === 'exit') tailExit = true;
								if (
									value.ok === false &&
									value.error?.includes('buffer') === true
								)
									overflowFrame = true;
							}
						});
						tail.write(`${JSON.stringify(tailRequestValue)}\n`);
						for (let attempt = 0; attempt < 100; attempt += 1) {
							if (tailReady) break;
							yield* Effect.sleep('10 millis');
						}
						expect(tailReady).toBe(true);
						const fileSystem = yield* FileSystem;
						yield* fileSystem.writeFileString(gatePath, 'go');
						let outputReady = false;
						for (let attempt = 0; attempt < 500; attempt += 1) {
							if (yield* fileSystem.exists(outputReadyPath)) {
								outputReady = true;
								break;
							}
							yield* Effect.sleep('10 millis');
						}
						expect(outputReady).toBe(true);
						const started = performance.now();
						const stopped = (yield* daemon
							.request({
								version: 1,
								requestId: 'stop-paused',
								method: 'stopRun',
								params: { runId: 'paused-stop' },
							} as DaemonRequest)
							.pipe(Effect.timeout('10 seconds'))) as RunRecord;
						const latency = performance.now() - started;
						console.info(`paused tail stop latency: ${Math.round(latency)}ms`);
						expect(stopped.state).toBe('exited');
						expect(stopped.services[0]?.state).toBe('exited');
						const logs = yield* Logs;
						const replay = yield* logs.replayAndSubscribe(
							{ runId: 'paused-stop', serviceName: 'web' },
							0,
							() => Effect.void,
						);
						expect(replay.replay.map((event) => event.data).join('')).toContain(
							'FINAL',
						);
						yield* replay.unsubscribe;
						tail.resume();
						for (let attempt = 0; attempt < 150; attempt += 1) {
							if (tailClosed || tailExit || overflowFrame) break;
							yield* Effect.sleep('20 millis');
						}
						expect(tailClosed || tailExit || overflowFrame).toBe(true);
					}).pipe(Effect.provide(daemonLayer)),
				);
			}),
		),
	);

	it.live(
		'delivers an overflow error to a SIGSTOPped tail after stop completes',
		() =>
			runTest(
				Effect.gen(function* () {
					const root = yield* makeTempDir;
					const canonicalRoot = yield* Effect.try({
						try: () => realpathSync(root),
						catch: (cause) =>
							new Error(`Could not resolve test directory ${root}`, { cause }),
					});
					const stateHome = join(root, 'state');
					const runtimeDirectory = join(root, 'runtime');
					const dataDirectory = join(stateHome, 'devsess');
					const socketPath = join(runtimeDirectory, 'devsess', 'devsess.sock');
					const gatePath = join(root, 'emit.ready');
					const outputReadyPath = join(root, 'output.ready');
					const fileSystem = yield* FileSystem;
					yield* fileSystem.makeDirectory(join(runtimeDirectory, 'devsess'), {
						recursive: true,
					});
					const dependencies = Layer.mergeAll(
						Registry.layer({ dataDirectory }),
						Logs.layer({ dataDirectory, maxBytes: 1024 * 1024 }),
						Processes.layer,
					);
					const daemonLayer = Layer.effect(
						Daemon,
						makeDaemon({ socketPath }),
					).pipe(Layer.provideMerge(dependencies));
					yield* Effect.scoped(
						Effect.gen(function* () {
							const daemon = yield* Daemon;
							const command = `${process.execPath} -e 'const fs=require("node:fs"); const gate=${JSON.stringify(gatePath)}; const outputReady=${JSON.stringify(outputReadyPath)}; process.stdout.write("TAIL_READY\\n"); const timer=setInterval(() => { if (fs.existsSync(gate)) { clearInterval(timer); process.stdout.write("x".repeat(8 * 1024 * 1024)); process.stdout.write("FINAL"); fs.writeFileSync(outputReady, "ready"); setTimeout(() => {}, 30000); } }, 5)'`;
							yield* daemon.request(
								startRequest('sigstop-tail', command, root, canonicalRoot),
							);
							const tail = yield* Effect.acquireRelease(
								startTailClient({
									cwd: canonicalRoot,
									stateHome,
									runtimeDirectory,
								}),
								stopTailClient,
							);
							yield* Deferred.await(tail.ready).pipe(
								Effect.timeout('5 seconds'),
							);
							yield* Effect.sync(() => process.kill(tail.pid, 'SIGSTOP'));
							yield* fileSystem.writeFileString(gatePath, 'go');
							let outputReady = false;
							for (let attempt = 0; attempt < 500; attempt += 1) {
								if (yield* fileSystem.exists(outputReadyPath)) {
									outputReady = true;
									break;
								}
								yield* Effect.sleep('10 millis');
							}
							expect(outputReady).toBe(true);
							const stopping = yield* daemon
								.request({
									version: 1,
									requestId: 'stop-sigstop-tail',
									method: 'stopRun',
									params: { runId: 'sigstop-tail' },
								} as DaemonRequest)
								.pipe(Effect.forkScoped({ startImmediately: true }));
							const stopped = (yield* Fiber.join(stopping).pipe(
								Effect.timeout('10 seconds'),
							)) as RunRecord;
							expect(stopped.state).toBe('exited');
							yield* Effect.sync(() => process.kill(tail.pid, 'SIGCONT'));
							const exited = yield* Deferred.await(tail.closed).pipe(
								Effect.timeout('5 seconds'),
							);
							expect(exited.exitCode).toBe(1);
							expect(tail.output()).toContain(LIVE_OUTPUT_OVERFLOW_MESSAGE);
							expect(tail.output()).not.toContain(
								'Daemon output stream closed',
							);
						}).pipe(Effect.provide(daemonLayer)),
					);
				}),
			),
	);

	it.live(
		'releases a SIGSTOPped attach lease before its overflow frame drains',
		() =>
			runTest(
				Effect.gen(function* () {
					const root = yield* makeTempDir;
					const canonicalRoot = yield* Effect.try({
						try: () => realpathSync(root),
						catch: (cause) =>
							new Error(`Could not resolve test directory ${root}`, { cause }),
					});
					const stateHome = join(root, 'state');
					const runtimeDirectory = join(root, 'runtime');
					const dataDirectory = join(stateHome, 'devsess');
					const socketPath = join(runtimeDirectory, 'devsess', 'devsess.sock');
					const gatePath = join(root, 'emit.ready');
					const outputReadyPath = join(root, 'output.ready');
					const fileSystem = yield* FileSystem;
					yield* fileSystem.makeDirectory(join(runtimeDirectory, 'devsess'), {
						recursive: true,
					});
					const dependencies = Layer.mergeAll(
						Registry.layer({ dataDirectory }),
						Logs.layer({ dataDirectory, maxBytes: 1024 * 1024 }),
						Processes.layer,
					);
					const daemonLayer = Layer.effect(
						Daemon,
						makeDaemon({ socketPath }),
					).pipe(Layer.provideMerge(dependencies));
					yield* Effect.scoped(
						Effect.gen(function* () {
							const daemon = yield* Daemon;
							const command = `${process.execPath} -e 'const fs=require("node:fs"); const gate=${JSON.stringify(gatePath)}; const outputReady=${JSON.stringify(outputReadyPath)}; const timer=setInterval(() => { if (fs.existsSync(gate)) { clearInterval(timer); process.stdout.write("x".repeat(8 * 1024 * 1024)); fs.writeFileSync(outputReady, "ready"); setTimeout(() => {}, 30000); } }, 5)'`;
							yield* daemon.request(
								startRequest('sigstop-attach', command, root, canonicalRoot),
							);
							const attached = yield* Effect.acquireRelease(
								startAttachClient({
									cwd: canonicalRoot,
									stateHome,
									runtimeDirectory,
								}),
								stopAttachClient,
							);
							yield* Deferred.await(attached.ready).pipe(
								Effect.timeout('5 seconds'),
							);
							yield* Effect.sleep('250 millis');
							yield* Effect.sync(() => process.kill(attached.pid, 'SIGSTOP'));
							yield* fileSystem.writeFileString(gatePath, 'go');
							let outputReady = false;
							for (let attempt = 0; attempt < 500; attempt += 1) {
								if (yield* fileSystem.exists(outputReadyPath)) {
									outputReady = true;
									break;
								}
								yield* Effect.sleep('10 millis');
							}
							expect(outputReady).toBe(true);
							const started = performance.now();
							const replacement = yield* attachUntilSuccessful(
								socketPath,
								'sigstop-attach',
							).pipe(Effect.timeout('1 second'));
							const latency = performance.now() - started;
							expect(replacement).toMatchObject({
								leaseId: expect.any(String),
							});
							expect(latency).toBeLessThan(1_000);
							yield* Effect.sync(() => process.kill(attached.pid, 'SIGCONT'));
							const exited = yield* Deferred.await(attached.closed).pipe(
								Effect.timeout('5 seconds'),
							);
							expect(exited.exitCode).toBe(1);
							expect(attached.output()).toContain(LIVE_OUTPUT_OVERFLOW_MESSAGE);
							expect(attached.output()).not.toContain(
								'Daemon output stream closed',
							);
						}).pipe(Effect.provide(daemonLayer)),
					);
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
