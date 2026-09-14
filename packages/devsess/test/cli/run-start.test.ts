import { describe, expect, it } from '@effect/vitest';
import { Deferred, Effect, Fiber } from 'effect';
import type { IPty } from 'node-pty';
import { vi } from 'vitest';
import type { OutputWorker } from '../../src/cli/output-worker';
import type { ProcessIdentity } from '../../src/cli/processes';
import type { DaemonRequest } from '../../src/cli/protocol';
import { createPty } from '../../src/cli/pty';
import { Registry, type RunRecord } from '../../src/cli/registry';
import { makeRunStart } from '../../src/cli/run-start';
import type { ServiceStateApi } from '../../src/cli/service-state';
import { runTest } from '../support/run-test';

vi.mock('../../src/cli/pty', async (importOriginal) => {
	const actual = await importOriginal<typeof import('../../src/cli/pty')>();
	return { ...actual, createPty: vi.fn() };
});

const identity: ProcessIdentity = {
	pid: 1234,
	processGroupId: 1234,
	startedAt: 'birth',
};

const startRequest: Extract<DaemonRequest, { method: 'startRun' }> = {
	version: 1,
	requestId: 'start',
	method: 'startRun',
	params: {
		runId: 'run',
		projectName: 'project',
		presetName: 'dev',
		canonicalCwd: '/tmp',
		invocationCwd: '/tmp',
		configSnapshot: {},
		environment: {},
		services: [{ name: 'web', command: 'sleep 30', cwd: '/tmp' }],
	},
};

describe('run start registration ordering', () => {
	it.live('persists running before releasing a buffered exit', () =>
		runTest(
			Effect.scoped(
				Effect.gen(function* () {
					const records = new Map<string, RunRecord>();
					const runningWriteStarted = yield* Deferred.make<void>();
					const allowRunningWrite = yield* Deferred.make<void>();
					const captureStarted = yield* Deferred.make<void>();
					const allowCapture = yield* Deferred.make<void>();
					let exitNotified = false;
					const terminalExitListeners: Array<
						(event: {
							readonly exitCode: number;
							readonly signal?: number;
						}) => void
					> = [];
					const terminal = {
						pid: 1234,
						onData: vi.fn(() => ({ dispose: () => undefined })),
						onExit: vi.fn(
							(
								listener: (event: {
									readonly exitCode: number;
									readonly signal?: number;
								}) => void,
							) => {
								terminalExitListeners.push(listener);
								return { dispose: () => undefined };
							},
						),
						write: vi.fn(),
						resize: vi.fn(),
						kill: vi.fn(),
						pause: vi.fn(),
						resume: vi.fn(),
						clear: vi.fn(),
					} as unknown as IPty;
					vi.mocked(createPty).mockReturnValue(Effect.succeed(terminal));
					const ownership = {
						identity,
						terminate: Effect.succeed<number | undefined>(9),
					};
					const registry = Registry.of({
						get: (runId: string) =>
							Effect.suspend(() => {
								const run = records.get(runId);
								return run === undefined
									? Effect.die(`Missing run ${runId}`)
									: Effect.succeed(run);
							}),
						reserve: (run: RunRecord) =>
							Effect.sync(() => {
								records.set(run.runId, run);
							}),
						replace: (run: RunRecord) => {
							if (run.services.some((service) => service.state === 'running'))
								return Deferred.succeed(runningWriteStarted, undefined).pipe(
									Effect.andThen(Deferred.await(allowRunningWrite)),
									Effect.map(() => {
										records.set(run.runId, run);
										return run;
									}),
								);
							records.set(run.runId, run);
							return Effect.succeed(run);
						},
						list: Effect.succeed([]),
					});
					const output = {
						start: () => Effect.succeed(undefined),
						enqueue: () => undefined,
						awaitIdle: () => Effect.void,
						close: () => Effect.void,
					} as unknown as OutputWorker;
					const serviceState = {
						replaceService: (
							_address: {
								readonly runId: string;
								readonly serviceName: string;
							},
							_state: 'starting',
						) => Effect.die('unused'),
						refreshServiceRecord: (run: RunRecord['services'][number]) =>
							Effect.succeed(run),
						reconcile: Effect.void,
					} as unknown as ServiceStateApi;
					const runStart = makeRunStart({
						registry,
						processes: {
							captureLive: () =>
								Deferred.succeed(captureStarted, undefined).pipe(
									Effect.andThen(Deferred.await(allowCapture)),
									Effect.as(ownership),
								),
						} as never,
						daemonIdentity: identity,
						terminals: new Map(),
						output,
						serviceState,
						stopRun: () => Effect.die('unused'),
						onExited: (address, _exit) => {
							exitNotified = true;
							const run = records.get(address.runId);
							if (run === undefined) throw new Error('Missing run');
							const services = run.services.map((service) =>
								service.name === address.serviceName
									? { ...service, state: 'failed' as const }
									: service,
							);
							records.set(address.runId, {
								...run,
								services,
								state: 'failed',
							});
						},
					});
					const startFiber = yield* runStart
						.startRun(startRequest)
						.pipe(Effect.forkScoped({ startImmediately: true }));
					yield* Deferred.await(captureStarted).pipe(
						Effect.timeout('1 second'),
					);
					const onExit = terminalExitListeners[0];
					if (onExit === undefined)
						return yield* Effect.die('Missing exit listener');
					onExit({ exitCode: 7, signal: 9 });
					yield* Deferred.succeed(allowCapture, undefined);
					yield* Deferred.await(runningWriteStarted).pipe(
						Effect.timeout('1 second'),
					);
					expect(exitNotified).toBe(false);
					expect(records.get('run')?.state).toBe('starting');
					yield* Deferred.succeed(allowRunningWrite, undefined);
					yield* Fiber.join(startFiber);
					expect(exitNotified).toBe(true);
					expect(records.get('run')?.state).toBe('failed');
				}),
			),
		),
	);
});
