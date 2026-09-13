import { createConnection, createServer, Socket } from 'node:net';
import { join } from 'node:path';
import { describe, expect, it } from '@effect/vitest';
import { Cause, Deferred, Effect, Exit, Layer, Schema } from 'effect';
import { vi } from 'vitest';
import { callDaemon } from '../../src/cli/client';
import { Daemon, makeDaemon } from '../../src/cli/daemon';
import { type LogAddress, type LogEvent, Logs } from '../../src/cli/logs';
import { ProcessError, Processes } from '../../src/cli/processes';
import type { DaemonRequest } from '../../src/cli/protocol';
import { createPty, terminatePty } from '../../src/cli/pty';
import { Registry, type RunRecord } from '../../src/cli/registry';
import { runTest } from '../support/run-test';
import { makeTempDir } from '../support/temp-dir';

vi.mock('node:net', async (importOriginal) => {
	const actual = await importOriginal<typeof import('node:net')>();
	return { ...actual, createServer: vi.fn(actual.createServer) };
});
vi.mock('../../src/cli/pty', async (importOriginal) => {
	const actual = await importOriginal<typeof import('../../src/cli/pty')>();
	return {
		...actual,
		createPty: vi.fn(),
		terminatePty: vi.fn(() => Effect.void),
	};
});

const start = (
	runId = 'run',
): Extract<DaemonRequest, { method: 'startRun' }> => ({
	version: 1,
	requestId: 'start',
	method: 'startRun',
	params: {
		runId,
		projectName: 'project',
		presetName: 'dev',
		canonicalCwd: '/tmp',
		invocationCwd: '/tmp',
		configSnapshot: {},
		environment: {},
		services: [{ name: 'web', command: 'sleep 30', cwd: '/tmp' }],
	},
});
const list: DaemonRequest = {
	version: 1,
	requestId: 'list',
	method: 'listRuns',
	params: {},
};
const stop: DaemonRequest = {
	version: 1,
	requestId: 'stop',
	method: 'stopRun',
	params: { runId: 'run' },
};
const identity = (pid: number) => ({
	pid,
	processGroupId: pid,
	startedAt: 'birth',
});
const orphanedRun = (runId: string): RunRecord => ({
	runId,
	projectName: 'project',
	presetName: 'dev',
	canonicalCwd: '/tmp',
	invocationCwd: '/tmp',
	configSnapshot: {},
	startedAt: '2026-09-09T00:00:00.000Z',
	state: 'orphaned',
	daemon: identity(12345),
	services: [
		{
			name: 'web',
			command: 'sleep 30',
			cwd: '/tmp',
			state: 'orphaned',
			process: identity(98765),
		},
	],
});
const processlessRun = (runId: string): RunRecord => ({
	runId,
	projectName: 'project',
	presetName: 'dev',
	canonicalCwd: '/tmp',
	invocationCwd: '/tmp',
	configSnapshot: {},
	startedAt: '2026-09-09T00:00:00.000Z',
	state: 'starting',
	daemon: identity(12345),
	services: [
		{
			name: 'web',
			command: 'sleep 30',
			cwd: '/tmp',
			state: 'starting',
		},
	],
});
const delayedLogs = () => {
	const listeners = new Map<string, (event: LogEvent) => Effect.Effect<void>>();
	const pending = new Map<string, Set<Deferred.Deferred<void>>>();
	const key = (address: LogAddress) =>
		`${address.runId}:${address.serviceName}`;
	const append = (address: LogAddress, data: string) =>
		Effect.gen(function* () {
			const event = { data, offset: data.length };
			const listener = listeners.get(key(address));
			if (listener !== undefined) {
				const completion = yield* Deferred.make<void>();
				const current = pending.get(key(address));
				const pendingEvents =
					current === undefined ? new Set<Deferred.Deferred<void>>() : current;
				pendingEvents.add(completion);
				pending.set(key(address), pendingEvents);
				yield* Effect.gen(function* () {
					yield* Effect.sleep('25 millis');
					if (listeners.get(key(address)) === listener) yield* listener(event);
				}).pipe(
					Effect.ensuring(
						Effect.sync(() => {
							pendingEvents.delete(completion);
						}).pipe(Effect.andThen(Deferred.succeed(completion, undefined))),
					),
					Effect.forkDetach,
				);
			}
			return event;
		});
	const replayAndSubscribe = (
		address: LogAddress,
		_after: number,
		listener: (event: LogEvent) => Effect.Effect<void>,
	) =>
		Effect.sync(() => {
			const addressKey = key(address);
			listeners.set(addressKey, listener);
			const current = pending.get(addressKey);
			const pendingEvents =
				current === undefined ? new Set<Deferred.Deferred<void>>() : current;
			pending.set(addressKey, pendingEvents);
			return {
				replay: [] as Array<LogEvent>,
				flush: Effect.suspend(() =>
					Effect.forEach(
						Array.from(pendingEvents),
						(completion) => Deferred.await(completion),
						{ discard: true },
					),
				),
				unsubscribe: Effect.sync(() => {
					listeners.delete(addressKey);
				}),
			};
		});
	return Logs.of({ append, replayAndSubscribe });
};
const fixture = () => {
	const records = new Map<string, RunRecord>();
	const get = (runId: string) =>
		Effect.suspend(() => {
			const run = records.get(runId);
			return run === undefined
				? Effect.die(`Missing fixture run ${runId}`)
				: Effect.succeed(run);
		});
	const replace = vi.fn(
		(run: RunRecord): Effect.Effect<RunRecord, Schema.SchemaError> =>
			Effect.sync(() => {
				records.set(run.runId, run);
				return run;
			}),
	);
	const registry = Registry.of({
		get,
		replace,
		reserve: (run) =>
			Effect.sync(() => {
				records.set(run.runId, run);
			}),
		list: Effect.sync(() => [...records.values()]),
	});
	const terminate = vi.fn(
		(
			_identity: ReturnType<typeof identity>,
		): Effect.Effect<void, ProcessError> => Effect.void,
	);
	const groupAlive = vi.fn(() => Effect.succeed(true));
	const capture = vi.fn(
		(pid: number): Effect.Effect<ReturnType<typeof identity>, ProcessError> =>
			Effect.succeed(identity(pid)),
	);
	const unsubscribe = vi.fn(() => undefined);
	const processes = Processes.of({
		capture,
		captureLive: (pid) =>
			capture(pid).pipe(
				Effect.map((identity) => ({
					identity,
					terminate: Effect.suspend(() => terminate(identity)),
				})),
			),
		terminate,
		groupAlive,
		owns: () => Effect.succeed(true),
	});
	const logs = Logs.of({
		append: (_address, data) => Effect.succeed({ data, offset: data.length }),
		replayAndSubscribe: () =>
			Effect.succeed({
				replay: [],
				flush: Effect.void,
				unsubscribe: Effect.sync(unsubscribe),
			}),
	});
	const terminal = {
		pid: 98765,
		cols: 80,
		rows: 24,
		process: 'shell',
		handleFlowControl: false,
		onData: vi.fn((_listener: (data: string) => void) => ({
			dispose: () => undefined,
		})),
		onExit: vi.fn(
			(_listener: (event: { exitCode: number; signal?: number }) => void) => ({
				dispose: () => undefined,
			}),
		),
		write: vi.fn(),
		resize: vi.fn(),
		kill: vi.fn(),
		pause: vi.fn(),
		resume: vi.fn(),
		clear: vi.fn(),
	};
	vi.mocked(createPty).mockReturnValue(Effect.succeed(terminal));
	vi.mocked(terminatePty).mockClear();
	const layerWithLogs = (socketPath: string, configuredLogs: typeof logs) =>
		Layer.effect(Daemon, makeDaemon({ socketPath })).pipe(
			Layer.provide(Layer.succeed(Registry, registry)),
			Layer.provide(Layer.succeed(Logs, configuredLogs)),
			Layer.provide(Layer.succeed(Processes, processes)),
		);
	const layer = (socketPath: string) => layerWithLogs(socketPath, logs);
	return {
		records,
		registry,
		replace,
		terminate,
		groupAlive,
		capture,
		unsubscribe,
		terminal,
		layer,
		layerWithLogs,
	};
};
const lastServer = () => {
	const result = vi.mocked(createServer).mock.results.at(-1);
	if (result?.type !== 'return')
		throw new Error('Daemon did not create a server');
	return result.value;
};

describe('daemon lifetime and failure handling', () => {
	it.live(
		'keeps the layer worker and socket alive until scope closure, then persists exits',
		() =>
			runTest(
				Effect.gen(function* () {
					const root = yield* makeTempDir;
					const state = fixture();
					const socketPath = join(root, 'daemon.sock');
					yield* Effect.gen(function* () {
						const daemon = yield* Daemon;
						yield* Effect.sleep('10 millis');
						expect(
							yield* daemon.request(list).pipe(Effect.timeout('1 second')),
						).toEqual([]);
						yield* daemon.request(start());
						const client = createConnection(socketPath);
						client.on('error', () => undefined);
						yield* Effect.promise(
							() =>
								new Promise<void>((resolve) => client.once('connect', resolve)),
						);
						expect(lastServer().listening).toBe(true);
						client.write(
							`${JSON.stringify({ version: 1, requestId: 'tail', method: 'tail', params: { runId: 'run', serviceName: 'web' } })}\n`,
						);
						yield* Effect.promise(
							() =>
								new Promise<void>((resolve) =>
									client.once('data', () => resolve()),
								),
						);
					}).pipe(
						Effect.provide(state.layer(socketPath)),
						Effect.timeout('2 seconds'),
					);
					expect(lastServer().listening).toBe(false);
					expect(state.unsubscribe).toHaveBeenCalledOnce();
					expect((yield* state.registry.get('run')).services[0]?.state).toBe(
						'exited',
					);
					expect(state.terminate).toHaveBeenCalledWith(identity(98765));
				}),
			),
	);

	it.live('reports termination failures and keeps failed stops active', () =>
		runTest(
			Effect.gen(function* () {
				const root = yield* makeTempDir;
				const state = fixture();
				yield* Effect.gen(function* () {
					const daemon = yield* Daemon;
					yield* daemon.request(start());
					state.terminate.mockReturnValueOnce(
						new ProcessError({ message: 'permission denied' }),
					);
					const result = yield* Effect.exit(daemon.request(stop));
					expect(Exit.isFailure(result)).toBe(true);
					if (Exit.isFailure(result))
						expect(Cause.pretty(result.cause)).toContain(
							'Could not stop all services',
						);
					expect((yield* state.registry.get('run')).services[0]?.state).toBe(
						'stopping',
					);
				}).pipe(Effect.provide(state.layer(join(root, 'daemon.sock'))));
			}),
		),
	);

	it.live('reports an actionable remedy for an unverifiable orphan', () =>
		runTest(
			Effect.gen(function* () {
				const root = yield* makeTempDir;
				const state = fixture();
				state.records.set('orphan', orphanedRun('orphan'));
				yield* Effect.gen(function* () {
					const daemon = yield* Daemon;
					state.terminate.mockReturnValueOnce(
						new ProcessError({
							message:
								'Cannot verify recovered process group 98765 after its leader exited',
						}),
					);
					const result = yield* Effect.exit(
						daemon.request({
							version: 1,
							requestId: 'stop-orphan',
							method: 'stopRun',
							params: { runId: 'orphan' },
						}),
					);
					expect(Exit.isFailure(result)).toBe(true);
					if (Exit.isFailure(result)) {
						const message = Cause.pretty(result.cause);
						expect(message).toContain('Service web');
						expect(message).toContain('run orphan');
						expect(message).toContain('98765');
						expect(message).toContain('kill -TERM -98765');
						expect(message).toContain('devsess stop --force');
					}
					expect((yield* state.registry.get('orphan')).state).toBe('orphaned');
				}).pipe(Effect.provide(state.layer(join(root, 'daemon.sock'))));
			}),
		),
	);

	it.live('points a blocked start at the orphan remedy', () =>
		runTest(
			Effect.gen(function* () {
				const root = yield* makeTempDir;
				const state = fixture();
				state.records.set('orphan', orphanedRun('orphan'));
				yield* Effect.gen(function* () {
					const daemon = yield* Daemon;
					const result = yield* Effect.exit(
						daemon.request(start('replacement')),
					);
					expect(Exit.isFailure(result)).toBe(true);
					if (Exit.isFailure(result)) {
						const message = Cause.pretty(result.cause);
						expect(message).toContain('Service web');
						expect(message).toContain('kill -TERM -98765');
						expect(message).toContain('devsess stop --force');
					}
				}).pipe(Effect.provide(state.layer(join(root, 'daemon.sock'))));
			}),
		),
	);

	it.live('force stops an orphan and unblocks a replacement start', () =>
		runTest(
			Effect.gen(function* () {
				const root = yield* makeTempDir;
				const state = fixture();
				state.records.set('orphan', orphanedRun('orphan'));
				yield* Effect.gen(function* () {
					const daemon = yield* Daemon;
					state.groupAlive.mockReturnValueOnce(Effect.succeed(true));
					state.groupAlive.mockReturnValue(Effect.succeed(false));
					const result = yield* daemon.request({
						version: 1,
						requestId: 'force-stop-orphan',
						method: 'stopRun',
						params: { runId: 'orphan', force: true },
					});
					expect(result).toMatchObject({ state: 'exited' });
					expect(state.terminate).toHaveBeenCalledWith(identity(98765), true);
					const replacement = yield* daemon.request(start('replacement'));
					expect(replacement).toMatchObject({ runId: 'replacement' });
				}).pipe(Effect.provide(state.layer(join(root, 'daemon.sock'))));
			}),
		),
	);

	it.live(
		'refuses duplicate identity when aggregate failed still contains a running service',
		() =>
			runTest(
				Effect.gen(function* () {
					const root = yield* makeTempDir;
					const state = fixture();
					yield* Effect.gen(function* () {
						const daemon = yield* Daemon;
						yield* daemon.request(start());
						const run = yield* state.registry.get('run');
						yield* state.registry.replace({
							...run,
							state: 'failed',
							services: [
								...run.services,
								{
									name: 'broken',
									command: 'false',
									cwd: '/tmp',
									state: 'failed',
								},
							],
						});
						const result = yield* Effect.exit(
							daemon.request(start('duplicate')),
						);
						expect(Exit.isFailure(result)).toBe(true);
						expect(state.records.has('duplicate')).toBe(false);
					}).pipe(Effect.provide(state.layer(join(root, 'daemon.sock'))));
				}),
			),
	);

	it.live('stops an orphaned run whose recovered group is already dead', () =>
		runTest(
			Effect.gen(function* () {
				const root = yield* makeTempDir;
				const state = fixture();
				state.records.set('orphan', orphanedRun('orphan'));
				yield* Effect.gen(function* () {
					const daemon = yield* Daemon;
					state.groupAlive.mockReturnValueOnce(Effect.succeed(false));
					const result = yield* daemon.request({
						version: 1,
						requestId: 'stop-orphan',
						method: 'stopRun',
						params: { runId: 'orphan' },
					});
					expect(result).toMatchObject({ state: 'exited' });
					expect(state.terminate).not.toHaveBeenCalled();
					expect((yield* state.registry.get('orphan')).state).toBe('exited');
				}).pipe(Effect.provide(state.layer(join(root, 'daemon.sock'))));
			}),
		),
	);

	it.live('resolves a processless starting record during reconciliation', () =>
		runTest(
			Effect.gen(function* () {
				const root = yield* makeTempDir;
				const state = fixture();
				state.records.set('crashed', processlessRun('crashed'));
				yield* Effect.gen(function* () {
					const daemon = yield* Daemon;
					const recovered = yield* state.registry.get('crashed');
					expect(recovered.state).toBe('exited');
					expect(recovered.services[0]?.state).toBe('exited');
					expect(recovered.services[0]?.process).toBeUndefined();
					const replacement = yield* daemon.request(start('replacement'));
					expect(replacement).toMatchObject({ runId: 'replacement' });
				}).pipe(Effect.provide(state.layer(join(root, 'daemon.sock'))));
			}),
		),
	);

	it.live('allows a new start after an orphaned group has disappeared', () =>
		runTest(
			Effect.gen(function* () {
				const root = yield* makeTempDir;
				const state = fixture();
				state.records.set('orphan', orphanedRun('orphan'));
				yield* Effect.gen(function* () {
					const daemon = yield* Daemon;
					state.groupAlive.mockReturnValue(Effect.succeed(false));
					const result = yield* daemon.request(start('replacement'));
					expect(result).toMatchObject({ runId: 'replacement' });
					expect(state.records.has('replacement')).toBe(true);
				}).pipe(Effect.provide(state.layer(join(root, 'daemon.sock'))));
			}),
		),
	);

	it.live('echoes a decodable request id for malformed requests', () =>
		runTest(
			Effect.gen(function* () {
				const root = yield* makeTempDir;
				const state = fixture();
				yield* Effect.gen(function* () {
					yield* Daemon;
					const malformed = {
						version: 1,
						requestId: 'validation',
						method: 'stopRun',
						params: { runId: '' },
					} as unknown as DaemonRequest;
					const result = yield* Effect.exit(
						callDaemon(join(root, 'daemon.sock'), malformed),
					);
					expect(Exit.isFailure(result)).toBe(true);
					if (Exit.isFailure(result)) {
						const message = Cause.pretty(result.cause);
						expect(message).not.toContain('Daemon response ID did not match');
						expect(message).toContain('runId');
					}
				}).pipe(Effect.provide(state.layer(join(root, 'daemon.sock'))));
			}),
		),
	);

	it.live(
		'immediately terminates a new terminal when identity capture fails',
		() =>
			runTest(
				Effect.gen(function* () {
					const root = yield* makeTempDir;
					const state = fixture();
					yield* Effect.gen(function* () {
						const daemon = yield* Daemon;
						state.capture.mockReturnValueOnce(
							new ProcessError({ message: 'capture failed' }),
						);
						expect(
							Exit.isFailure(yield* Effect.exit(daemon.request(start()))),
						).toBe(true);
						expect(state.terminal.kill).toHaveBeenCalledWith('SIGKILL');
						expect(terminatePty).not.toHaveBeenCalled();
					}).pipe(Effect.provide(state.layer(join(root, 'daemon.sock'))));
				}),
			),
	);

	it.live(
		'immediately rolls back the new owned terminal when persistence fails',
		() =>
			runTest(
				Effect.gen(function* () {
					const root = yield* makeTempDir;
					const state = fixture();
					yield* Effect.gen(function* () {
						const daemon = yield* Daemon;
						const original = state.replace.getMockImplementation();
						if (original === undefined)
							return yield* Effect.die('Missing registry replacement');
						state.replace.mockImplementationOnce(() =>
							Schema.decodeUnknownEffect(Schema.Never)(undefined),
						);
						const result = yield* Effect.exit(
							daemon.request(start()).pipe(Effect.timeout('1 second')),
						);
						expect(Exit.isFailure(result)).toBe(true);
						expect(state.terminate).toHaveBeenCalledWith(identity(98765));
					}).pipe(Effect.provide(state.layer(join(root, 'daemon.sock'))));
				}),
			),
	);

	it.live(
		'cleans up the still-owned group before marking an exited PTY complete',
		() =>
			runTest(
				Effect.gen(function* () {
					const root = yield* makeTempDir;
					const state = fixture();
					yield* Effect.gen(function* () {
						const daemon = yield* Daemon;
						yield* daemon.request(start());
						const onExit = state.terminal.onExit.mock.calls[0]?.[0];
						if (onExit === undefined)
							return yield* Effect.die('Missing PTY exit callback');
						onExit({ exitCode: 0 });
						yield* daemon.request(list);
						expect(state.terminate).toHaveBeenCalledWith(identity(98765));
						expect((yield* state.registry.get('run')).services[0]?.state).toBe(
							'exited',
						);
					}).pipe(Effect.provide(state.layer(join(root, 'daemon.sock'))));
				}),
			),
	);

	it.live('completes every socket subscription when a PTY exits', () =>
		runTest(
			Effect.gen(function* () {
				const root = yield* makeTempDir;
				const state = fixture();
				yield* Effect.gen(function* () {
					const daemon = yield* Daemon;
					yield* daemon.request(start());
					const client = createConnection(join(root, 'daemon.sock'));
					client.on('error', () => undefined);
					const response = yield* Deferred.make<void>();
					const completed = yield* Deferred.make<void>();
					let received = '';
					client.on('data', (chunk) => {
						received += chunk.toString();
						if (received.includes('"ok":true'))
							Deferred.succeed(response, undefined).pipe(Effect.runFork);
						if (received.includes('"event":"exit"'))
							Deferred.succeed(completed, undefined).pipe(Effect.runFork);
					});
					yield* Effect.promise(
						() =>
							new Promise<void>((resolve) => client.once('connect', resolve)),
					);
					client.write(
						`${JSON.stringify({ version: 1, requestId: 'tail', method: 'tail', params: { runId: 'run', serviceName: 'web' } })}\n`,
					);
					yield* Deferred.await(response).pipe(Effect.timeout('1 second'));
					const onExit = state.terminal.onExit.mock.calls[0]?.[0];
					if (onExit === undefined)
						return yield* Effect.die('Missing PTY exit callback');
					onExit({ exitCode: 0, signal: 9 });
					yield* Deferred.await(completed).pipe(Effect.timeout('1 second'));
					expect(received).toContain('"event":"exit"');
					expect(received).toContain('"exitCode":0');
					expect(received).toContain('"signal":9');
					expect(state.unsubscribe).toHaveBeenCalledOnce();
					client.destroy();
				}).pipe(Effect.provide(state.layer(join(root, 'daemon.sock'))));
			}),
		),
	);

	it.live('completes subscriptions when stop removes a live terminal', () =>
		runTest(
			Effect.gen(function* () {
				const root = yield* makeTempDir;
				const state = fixture();
				yield* Effect.gen(function* () {
					const daemon = yield* Daemon;
					yield* daemon.request(start());
					const client = createConnection(join(root, 'daemon.sock'));
					client.on('error', () => undefined);
					const response = yield* Deferred.make<void>();
					const completed = yield* Deferred.make<void>();
					let received = '';
					client.on('data', (chunk) => {
						received += chunk.toString();
						if (received.includes('"requestId":"tail"'))
							Deferred.succeed(response, undefined).pipe(Effect.runFork);
						if (received.includes('"event":"exit"'))
							Deferred.succeed(completed, undefined).pipe(Effect.runFork);
					});
					yield* Effect.promise(
						() =>
							new Promise<void>((resolve) => client.once('connect', resolve)),
					);
					client.write(
						`${JSON.stringify({ version: 1, requestId: 'tail', method: 'tail', params: { runId: 'run', serviceName: 'web' } })}\n`,
					);
					yield* Deferred.await(response).pipe(Effect.timeout('1 second'));
					yield* daemon.request(stop);
					yield* Deferred.await(completed).pipe(Effect.timeout('1 second'));
					expect(received).toContain('"event":"exit"');
					expect(received).toContain('"signal":15');
					expect((yield* state.registry.get('run')).services[0]).toMatchObject({
						exitCode: 0,
						signal: 15,
					});
					client.destroy();
				}).pipe(Effect.provide(state.layer(join(root, 'daemon.sock'))));
			}),
		),
	);

	it.live(
		'replays and completes a service that exited before tail subscribed',
		() =>
			runTest(
				Effect.gen(function* () {
					const root = yield* makeTempDir;
					const state = fixture();
					const finished = start('finished');
					state.records.set('finished', {
						...finished.params,
						startedAt: '2026-09-09T00:00:00.000Z',
						state: 'exited',
						daemon: identity(12345),
						services: [
							{
								name: 'web',
								command: 'sleep 30',
								cwd: '/tmp',
								state: 'exited',
								exitCode: 7,
								signal: undefined,
							},
						],
					});
					yield* Effect.gen(function* () {
						yield* Daemon;
						const client = createConnection(join(root, 'daemon.sock'));
						client.on('error', () => undefined);
						const completed = yield* Deferred.make<void>();
						let received = '';
						client.on('data', (chunk) => {
							received += chunk.toString();
							if (received.includes('"event":"exit"'))
								Deferred.succeed(completed, undefined).pipe(Effect.runFork);
						});
						yield* Effect.promise(
							() =>
								new Promise<void>((resolve) => client.once('connect', resolve)),
						);
						client.write(
							`${JSON.stringify({ version: 1, requestId: 'tail-finished', method: 'tail', params: { runId: 'finished', serviceName: 'web' } })}\n`,
						);
						yield* Deferred.await(completed).pipe(Effect.timeout('1 second'));
						expect(received).toContain('"exitCode":7');
						client.destroy();
					}).pipe(Effect.provide(state.layer(join(root, 'daemon.sock'))));
				}),
			),
	);

	it.live('delivers the last output chunk before the exit frame', () =>
		runTest(
			Effect.gen(function* () {
				const root = yield* makeTempDir;
				const state = fixture();
				const logs = delayedLogs();
				yield* Effect.gen(function* () {
					const daemon = yield* Daemon;
					yield* daemon.request(start());
					const client = createConnection(join(root, 'daemon.sock'));
					client.on('error', () => undefined);
					const response = yield* Deferred.make<void>();
					const completed = yield* Deferred.make<void>();
					let received = '';
					client.on('data', (chunk) => {
						received += chunk.toString();
						if (received.includes('"ok":true'))
							Deferred.succeed(response, undefined).pipe(Effect.runFork);
						if (received.includes('"event":"exit"'))
							Deferred.succeed(completed, undefined).pipe(Effect.runFork);
					});
					yield* Effect.promise(
						() =>
							new Promise<void>((resolve) => client.once('connect', resolve)),
					);
					client.write(
						`${JSON.stringify({ version: 1, requestId: 'tail', method: 'tail', params: { runId: 'run', serviceName: 'web' } })}\n`,
					);
					yield* Deferred.await(response).pipe(Effect.timeout('1 second'));
					const onData = state.terminal.onData.mock.calls[0]?.[0];
					const onExit = state.terminal.onExit.mock.calls[0]?.[0];
					if (typeof onData !== 'function' || typeof onExit !== 'function')
						return yield* Effect.die('Missing PTY callbacks');
					onData('hello');
					onExit({ exitCode: 0 });
					yield* Deferred.await(completed).pipe(Effect.timeout('1 second'));
					const output = received.indexOf('"event":"output"');
					const exit = received.indexOf('"event":"exit"');
					expect(output).toBeGreaterThanOrEqual(0);
					expect(exit).toBeGreaterThan(output);
					expect(received).toContain('"data":"hello"');
					client.destroy();
				}).pipe(
					Effect.provide(state.layerWithLogs(join(root, 'daemon.sock'), logs)),
				);
			}),
		),
	);

	it.live(
		'waits for a backpressured socket before sending subsequent responses',
		() =>
			runTest(
				Effect.gen(function* () {
					const root = yield* makeTempDir;
					const state = fixture();
					yield* Effect.gen(function* () {
						const daemon = yield* Daemon;
						const socket = new Socket();
						const drained = yield* Deferred.make<void>();
						let isDrained = false;
						Object.defineProperty(socket, 'writableNeedDrain', {
							configurable: true,
							get: () => !isDrained,
						});
						const write = vi.spyOn(socket, 'write').mockImplementation(() => {
							setTimeout(() => {
								isDrained = true;
								socket.emit('drain');
								Effect.runFork(Deferred.succeed(drained, undefined));
							}, 10);
							return false;
						});
						lastServer().emit('connection', socket);
						socket.emit('data', Buffer.from(`${JSON.stringify(list)}\n`));
						yield* Deferred.await(drained).pipe(Effect.timeout('1 second'));
						yield* daemon.request(list).pipe(Effect.timeout('1 second'));
						expect(write).toHaveBeenCalledOnce();
						expect(socket.destroyed).toBe(false);
						expect(
							yield* daemon.request(list).pipe(Effect.timeout('1 second')),
						).toEqual([]);
					}).pipe(Effect.provide(state.layer(join(root, 'daemon.sock'))));
				}),
			),
	);

	it.live('reports socket buffer overflow before disconnecting', () =>
		runTest(
			Effect.gen(function* () {
				const root = yield* makeTempDir;
				const state = fixture();
				yield* Effect.gen(function* () {
					const daemon = yield* Daemon;
					const socket = new Socket();
					Object.defineProperty(socket, 'writableLength', {
						configurable: true,
						get: () => 1024 * 1024,
					});
					const written = yield* Deferred.make<string>();
					vi.spyOn(socket, 'write').mockImplementation((chunk) => {
						Effect.runFork(
							Deferred.succeed(
								written,
								typeof chunk === 'string' ? chunk : chunk.toString(),
							),
						);
						return true;
					});
					const end = vi.spyOn(socket, 'end').mockReturnValue(socket);
					lastServer().emit('connection', socket);
					socket.emit('data', Buffer.from(`${JSON.stringify(list)}\n`));
					const frame = JSON.parse(
						yield* Deferred.await(written).pipe(Effect.timeout('1 second')),
					) as { ok: boolean; error?: string };
					expect(frame.ok).toBe(false);
					expect(frame.error).toContain('output buffer exceeded');
					expect(end).toHaveBeenCalledOnce();
					yield* daemon.request(list).pipe(Effect.timeout('1 second'));
				}).pipe(Effect.provide(state.layer(join(root, 'daemon.sock'))));
			}),
		),
	);
});
