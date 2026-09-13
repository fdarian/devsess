import { createConnection, createServer, Socket } from 'node:net';
import { join } from 'node:path';
import { describe, expect, it } from '@effect/vitest';
import { Cause, Deferred, Effect, Exit, Layer, Schema } from 'effect';
import { vi } from 'vitest';
import { Daemon, makeDaemon } from '../../src/cli/daemon';
import { Logs } from '../../src/cli/logs';
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
		markOrphans: Effect.sync(() => [...records.values()]),
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
			Effect.succeed({ replay: [], unsubscribe: Effect.sync(unsubscribe) }),
	});
	const terminal = {
		pid: 98765,
		cols: 80,
		rows: 24,
		process: 'shell',
		handleFlowControl: false,
		onData: vi.fn(() => ({ dispose: () => undefined })),
		onExit: vi.fn((_listener: (event: { exitCode: number }) => void) => ({
			dispose: () => undefined,
		})),
		write: vi.fn(),
		resize: vi.fn(),
		kill: vi.fn(),
		pause: vi.fn(),
		resume: vi.fn(),
		clear: vi.fn(),
	};
	vi.mocked(createPty).mockReturnValue(Effect.succeed(terminal));
	vi.mocked(terminatePty).mockClear();
	const layer = (socketPath: string) =>
		Layer.effect(Daemon, makeDaemon({ socketPath })).pipe(
			Layer.provide(Layer.succeed(Registry, registry)),
			Layer.provide(Layer.succeed(Logs, logs)),
			Layer.provide(Layer.succeed(Processes, processes)),
		);
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
					onExit({ exitCode: 7 });
					yield* Deferred.await(completed).pipe(Effect.timeout('1 second'));
					expect(received).toContain('"event":"exit"');
					expect(received).toContain('"exitCode":7');
					expect(state.unsubscribe).toHaveBeenCalledOnce();
					client.destroy();
				}).pipe(Effect.provide(state.layer(join(root, 'daemon.sock'))));
			}),
		),
	);

	it.live(
		'drops a backpressured socket without blocking subsequent requests',
		() =>
			runTest(
				Effect.gen(function* () {
					const root = yield* makeTempDir;
					const state = fixture();
					yield* Effect.gen(function* () {
						const daemon = yield* Daemon;
						const socket = new Socket();
						const write = vi.spyOn(socket, 'write').mockReturnValue(false);
						lastServer().emit('connection', socket);
						socket.emit('data', Buffer.from(`${JSON.stringify(list)}\n`));
						yield* daemon.request(list).pipe(Effect.timeout('1 second'));
						expect(write).toHaveBeenCalledOnce();
						expect(socket.destroyed).toBe(true);
						expect(
							yield* daemon.request(list).pipe(Effect.timeout('1 second')),
						).toEqual([]);
					}).pipe(Effect.provide(state.layer(join(root, 'daemon.sock'))));
				}),
			),
	);
});
