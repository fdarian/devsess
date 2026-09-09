import { describe, expect, it } from '@effect/vitest';
import { Effect, Ref } from 'effect';
import { Logs } from '../../src/cli/logs';
import { Registry, type RunRecord } from '../../src/cli/registry';
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
					const subscription = yield* logs.replayAndSubscribe(
						address,
						0,
						(event) =>
							Ref.update(delivered, (events) => [...events, event.data]),
					);
					yield* logs.append(address, 'cd');
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
});
