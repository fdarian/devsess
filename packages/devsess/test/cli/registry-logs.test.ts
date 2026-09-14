import { describe, expect, it } from '@effect/vitest';
import { Deferred, Duration, Effect, Exit, Ref, Schema } from 'effect';
import { FileSystem } from 'effect/FileSystem';
import { Path } from 'effect/Path';
import { LogAddressSchema, Logs } from '../../src/cli/logs';
import {
	Registry,
	type RunRecord,
	RunRecordSchema,
	refreshService,
} from '../../src/cli/registry';
import { runTest } from '../support/run-test';
import { makeTempDir } from '../support/temp-dir';

const run = (runId: string): RunRecord => ({
	runId,
	projectName: 'workspace',
	presetName: 'dev',
	canonicalCwd: '/workspace',
	invocationCwd: '/workspace/apps/web',
	configSnapshot: { projects: {} },
	startedAt: '2026-09-09T00:00:00.000Z',
	state: 'starting',
	daemon: {
		pid: 123,
		processGroupId: 123,
		startedAt: 'Tue Sep  9 00:00:00 2026',
	},
	services: [],
});

describe('Registry', () => {
	it('rejects unsafe persisted process identifiers', () => {
		const exit = Effect.runSyncExit(
			Schema.decodeUnknownEffect(RunRecordSchema)({
				...run('unsafe'),
				daemon: {
					pid: 1,
					processGroupId: 0,
					startedAt: 'birth',
				},
			}),
		);
		expect(exit._tag).toBe('Failure');
	});

	it('accepts persisted service completion status', () => {
		const exit = Effect.runSyncExit(
			Schema.decodeUnknownEffect(RunRecordSchema)({
				...run('finished'),
				state: 'exited',
				services: [
					{
						name: 'web',
						command: 'exit 7',
						cwd: '/workspace',
						state: 'failed',
						exitCode: 7,
					},
				],
			}),
		);
		expect(exit._tag).toBe('Success');
	});

	it('accepts an explicit unknown completion status', () => {
		const exit = Effect.runSyncExit(
			Schema.decodeUnknownEffect(RunRecordSchema)({
				...run('unknown'),
				state: 'exited',
				services: [
					{
						name: 'web',
						command: 'sleep 30',
						cwd: '/workspace',
						state: 'exited',
						exitStatus: 'unknown',
					},
				],
			}),
		);
		expect(exit._tag).toBe('Success');
	});

	it('records unknown status when a persisted process is already dead', () => {
		const service = {
			name: 'web',
			command: 'sleep 30',
			cwd: '/workspace',
			state: 'running' as const,
			process: { pid: 123, processGroupId: 123, startedAt: 'birth' },
			exitCode: 7,
			signal: 9,
		};
		expect(refreshService(service, 'dead')).toMatchObject({
			state: 'exited',
			exitStatus: 'unknown',
		});
		expect(refreshService(service, 'dead').exitCode).toBeUndefined();
		expect(refreshService(service, 'dead').signal).toBeUndefined();
	});

	it.effect('atomically reserves the project and preset identity', () =>
		runTest(
			Effect.gen(function* () {
				const dataDirectory = yield* makeTempDir;
				const registry = yield* Registry.pipe(
					Effect.provide(Registry.layer({ dataDirectory })),
				);
				const exit = yield* Effect.exit(
					Effect.all(
						[registry.reserve(run('first')), registry.reserve(run('second'))],
						{ concurrency: 'unbounded' },
					),
				);
				expect(exit._tag).toBe('Failure');
				expect((yield* registry.list).map((record) => record.runId)).toEqual([
					'first',
				]);
			}),
		),
	);
});

describe('Logs', () => {
	it.effect('rejects path traversal in log addresses', () =>
		Effect.gen(function* () {
			const exit = yield* Effect.exit(
				Schema.decodeUnknownEffect(LogAddressSchema)({
					runId: '../../escape',
					serviceName: 'web',
				}),
			);
			expect(exit._tag).toBe('Failure');
		}),
	);

	it.effect(
		'bounds persisted events and has no replay-to-subscribe loss gap',
		() =>
			runTest(
				Effect.gen(function* () {
					const dataDirectory = yield* makeTempDir;
					const logs = yield* Logs.pipe(
						Effect.provide(Logs.layer({ dataDirectory, maxBytes: 3 })),
					);
					const address = { runId: 'run', serviceName: 'web' };
					yield* logs.append(address, 'ab');
					const delivered = yield* Ref.make([] as Array<string>);
					const deliveredSignal = yield* Deferred.make<void>();
					const subscription = yield* logs.replayAndSubscribe(
						address,
						0,
						(event) =>
							Effect.andThen(
								Ref.update(delivered, (events) => [...events, event.data]),
								Deferred.succeed(deliveredSignal, undefined),
							),
					);
					yield* logs.append(address, 'cd');
					yield* Deferred.await(deliveredSignal);
					expect(subscription.replay.map((event) => event.data)).toEqual([
						'ab',
					]);
					expect(yield* Ref.get(delivered)).toEqual(['cd']);
					yield* subscription.unsubscribe;
					const retained = yield* logs.replayAndSubscribe(
						address,
						0,
						() => Effect.void,
					);
					expect(retained.replay.map((event) => event.data)).toEqual([
						'ab',
						'cd',
					]);
					yield* retained.unsubscribe;
				}),
			),
	);

	it.effect('does not let a slow listener block append', () =>
		runTest(
			Effect.gen(function* () {
				const dataDirectory = yield* makeTempDir;
				const logs = yield* Logs.pipe(
					Effect.provide(Logs.layer({ dataDirectory, maxBytes: 1024 })),
				);
				const subscription = yield* logs.replayAndSubscribe(
					{ runId: 'run', serviceName: 'web' },
					0,
					() => Effect.never,
				);
				const result = yield* Effect.exit(
					Effect.timeout(
						logs.append({ runId: 'run', serviceName: 'web' }, 'output'),
						Duration.seconds(1),
					),
				);
				expect(Exit.isSuccess(result)).toBe(true);
				yield* subscription.unsubscribe;
			}),
		),
	);

	it.effect('retains a burst while a subscription listener is paused', () =>
		runTest(
			Effect.gen(function* () {
				const dataDirectory = yield* makeTempDir;
				const logs = yield* Logs.pipe(
					Effect.provide(Logs.layer({ dataDirectory, maxBytes: 4096 })),
				);
				const subscription = yield* logs.replayAndSubscribe(
					{ runId: 'run', serviceName: 'web' },
					0,
					() => Effect.never,
				);
				for (let index = 0; index < 258; index += 1)
					yield* logs.append({ runId: 'run', serviceName: 'web' }, 'x');
				yield* subscription.unsubscribe;
				const replay = yield* logs.replayAndSubscribe(
					{ runId: 'run', serviceName: 'web' },
					0,
					() => Effect.void,
				);
				expect(replay.replay).toHaveLength(258);
				yield* replay.unsubscribe;
			}),
		),
	);

	it.effect('keeps oversized events within the retention bound', () =>
		runTest(
			Effect.gen(function* () {
				const dataDirectory = yield* makeTempDir;
				const logs = yield* Logs.pipe(
					Effect.provide(Logs.layer({ dataDirectory, maxBytes: 3 })),
				);
				const address = { runId: 'run', serviceName: 'web' };
				yield* logs.append(address, 'abcd');
				const subscription = yield* logs.replayAndSubscribe(
					address,
					0,
					() => Effect.void,
				);
				expect(subscription.replay.map((event) => event.data)).toEqual([
					'abc',
					'd',
				]);
				yield* subscription.unsubscribe;
			}),
		),
	);

	it.effect('rotates JSONL segments and replays the newest two in order', () =>
		runTest(
			Effect.gen(function* () {
				const dataDirectory = yield* makeTempDir;
				const logs = yield* Logs.pipe(
					Effect.provide(Logs.layer({ dataDirectory, maxBytes: 80 })),
				);
				const address = { runId: 'run', serviceName: 'web' };
				for (const value of ['a', 'b', 'c', 'd', 'e', 'f', 'g'])
					yield* logs.append(address, value);
				const subscription = yield* logs.replayAndSubscribe(
					address,
					0,
					() => Effect.void,
				);
				const values = subscription.replay.map((event) => event.data);
				expect(values.length).toBeGreaterThan(0);
				expect(values).toEqual(['d', 'e', 'f', 'g']);
				const fileSystem = yield* FileSystem;
				const path = yield* Path;
				const directory = path.join(dataDirectory, 'logs', 'run');
				expect(
					yield* fileSystem.exists(path.join(directory, 'web.jsonl')),
				).toBe(true);
				expect(
					yield* fileSystem.exists(path.join(directory, 'web.1.jsonl')),
				).toBe(true);
				expect(
					yield* fileSystem.exists(path.join(directory, 'web.2.jsonl')),
				).toBe(false);
				yield* subscription.unsubscribe;
			}),
		),
	);

	it.effect('ignores a partial trailing JSONL line after a crash', () =>
		runTest(
			Effect.gen(function* () {
				const dataDirectory = yield* makeTempDir;
				const fileSystem = yield* FileSystem;
				const path = yield* Path;
				const directory = path.join(dataDirectory, 'logs', 'run');
				const target = path.join(directory, 'web.jsonl');
				yield* fileSystem.makeDirectory(directory, { recursive: true });
				yield* fileSystem.writeFileString(
					target,
					'{"data":"ok","offset":2}\n{"data":"crashed"',
					{ mode: 0o600 },
				);
				const logs = yield* Logs.pipe(
					Effect.provide(Logs.layer({ dataDirectory, maxBytes: 1024 })),
				);
				const subscription = yield* logs.replayAndSubscribe(
					{ runId: 'run', serviceName: 'web' },
					0,
					() => Effect.void,
				);
				expect(subscription.replay.map((event) => event.data)).toEqual(['ok']);
				yield* subscription.unsubscribe;
			}),
		),
	);

	it.effect('discards a valid partial record before the next append', () =>
		runTest(
			Effect.gen(function* () {
				const dataDirectory = yield* makeTempDir;
				const fileSystem = yield* FileSystem;
				const path = yield* Path;
				const directory = path.join(dataDirectory, 'logs', 'run');
				const target = path.join(directory, 'web.jsonl');
				yield* fileSystem.makeDirectory(directory, { recursive: true });
				yield* fileSystem.writeFileString(
					target,
					'{"data":"partial","offset":7}',
					{ mode: 0o600 },
				);
				const logs = yield* Logs.pipe(
					Effect.provide(Logs.layer({ dataDirectory, maxBytes: 1024 })),
				);
				const address = { runId: 'run', serviceName: 'web' };
				yield* logs.append(address, 'next');
				const subscription = yield* logs.replayAndSubscribe(
					address,
					0,
					() => Effect.void,
				);
				expect(subscription.replay.map((event) => event.data)).toEqual([
					'next',
				]);
				expect(yield* fileSystem.readFileString(target)).toContain('\n');
				yield* subscription.unsubscribe;
			}),
		),
	);

	it.effect('ignores legacy JSON logs instead of rewriting them', () =>
		runTest(
			Effect.gen(function* () {
				const dataDirectory = yield* makeTempDir;
				const fileSystem = yield* FileSystem;
				const path = yield* Path;
				const directory = path.join(dataDirectory, 'logs', 'run');
				yield* fileSystem.makeDirectory(directory, { recursive: true });
				yield* fileSystem.writeFileString(
					path.join(directory, 'web.json'),
					JSON.stringify({
						nextOffset: 4,
						events: [{ data: 'old', offset: 4 }],
					}),
				);
				const logs = yield* Logs.pipe(
					Effect.provide(Logs.layer({ dataDirectory, maxBytes: 1024 })),
				);
				const subscription = yield* logs.replayAndSubscribe(
					{ runId: 'run', serviceName: 'web' },
					0,
					() => Effect.void,
				);
				expect(subscription.replay).toEqual([]);
				yield* subscription.unsubscribe;
			}),
		),
	);
});
