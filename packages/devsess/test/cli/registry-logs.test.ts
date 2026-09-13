import { describe, expect, it } from '@effect/vitest';
import { Deferred, Duration, Effect, Exit, Ref, Schema } from 'effect';
import { LogAddressSchema, Logs } from '../../src/cli/logs';
import {
	Registry,
	type RunRecord,
	RunRecordSchema,
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
					expect(retained.replay.map((event) => event.data)).toEqual(['cd']);
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
				expect(subscription.replay.map((event) => event.data)).toEqual(['d']);
				yield* subscription.unsubscribe;
			}),
		),
	);
});
