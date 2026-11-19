import { join } from 'node:path';
import { describe, expect, it } from '@effect/vitest';
import { Deferred, Effect, Fiber } from 'effect';
import { FileSystem } from 'effect/FileSystem';
import { TestClock } from 'effect/testing';
import { vi } from 'vitest';
import {
	decodeRunListResponse,
	decodeRunResponse,
} from '../../src/cli/commands/daemon';
import { formatService } from '../../src/cli/commands/status';
import {
	makeMemorySampler,
	ProcessError,
	parseProcessTree,
	serviceMemoryBytes,
} from '../../src/cli/processes';
import { Registry, type RunRecord } from '../../src/cli/registry';
import { makeRequestDispatcher } from '../../src/cli/request-dispatch';
import type { LiveService } from '../../src/cli/service-state';
import { MEMORY_SAMPLE_MAX_WAIT_MS } from '../../src/cli/termination';
import { runTest } from '../support/run-test';
import { makeTempDir } from '../support/temp-dir';

const tree = parseProcessTree(
	[
		'100 1 100 S Tue Sep 22 00:00:00 2026 1024',
		'101 100 100 S Tue Sep 22 00:00:00 2026 2048',
		'102 101 102 S Tue Sep 22 00:00:00 2026 4096',
		'103 102 103 S Tue Sep 22 00:00:00 2026 8192',
		'200 1 200 S Tue Sep 22 00:00:00 2026 9999',
	].join('\n'),
);
const identity = { pid: 100, processGroupId: 100, startedAt: 'birth' };
const run: RunRecord = {
	runId: 'run',
	projectName: 'project',
	presetName: 'dev',
	canonicalCwd: '/workspace',
	invocationCwd: '/workspace',
	configSnapshot: {},
	startedAt: '2026-09-22T00:00:00.000Z',
	state: 'running',
	daemon: identity,
	services: [
		{
			name: 'web',
			command: 'sleep 30',
			cwd: '/workspace',
			state: 'running',
			process: identity,
		},
		{
			name: 'done',
			command: 'exit 0',
			cwd: '/workspace',
			state: 'exited',
			process: identity,
		},
	],
};

describe('service memory', () => {
	it.effect(
		'sums group members and escaped descendants once and caches samples for two seconds',
		() =>
			Effect.gen(function* () {
				expect(tree).toHaveLength(5);
				expect(serviceMemoryBytes([...tree, ...tree], identity)).toBe(
					15360 * 1024,
				);
				expect(serviceMemoryBytes([], identity)).toBeUndefined();
				let now = 0;
				const read = vi.fn(() => Effect.succeed(tree));
				const sample = makeMemorySampler(read, () => now);
				yield* sample;
				yield* sample;
				expect(read).toHaveBeenCalledTimes(1);
				now = 2000;
				yield* sample;
				expect(read).toHaveBeenCalledTimes(2);
			}),
	);

	it.effect(
		'enriches listRuns and getRun without persisting memory and omits it on failure or finished services',
		() =>
			runTest(
				Effect.gen(function* () {
					const root = yield* makeTempDir;
					const registry = yield* Registry.pipe(
						Effect.provide(
							Registry.layer({
								dataDirectory: root,
								logsDirectory: join(root, 'logs'),
							}),
						),
					);
					yield* registry.reserve(run);
					const read = vi.fn(() => Effect.succeed(tree));
					const drained = yield* Deferred.make<void>();
					const live: LiveService = {
						instanceId: 'instance',
						children: [],
						exit: undefined,
						address: { runId: 'run', serviceName: 'web' },
						ownership: { identity, terminate: Effect.succeed(undefined) },
						drained,
						lease: undefined,
						terminal: {} as never,
					};
					const terminals = new Map([['run:web', live]]);
					const create = (memorySample: ReturnType<typeof makeMemorySampler>) =>
						makeRequestDispatcher({
							registry,
							memorySample,
							terminals,
							environments: new Map(),
							sockets: new Map(),
							output: {} as never,
							serviceState: {} as never,
							subscriptions: {} as never,
							runStart: {} as never,
							runStop: {} as never,
							reply: () => Effect.void,
							fail: () => Effect.void,
						});
					const dispatcher = create(makeMemorySampler(read));
					const report = {
						version: 1 as const,
						requestId: 'report',
						method: 'reportService' as const,
						params: {
							runId: 'run',
							service: 'web',
							name: 'postgres',
							instanceId: 'instance',
							ports: { sql: 5432 },
						},
					};
					yield* dispatcher.processRequest(report, undefined);
					const list = {
						version: 1 as const,
						requestId: 'list',
						method: 'listRuns' as const,
						params: {},
					};
					const get = {
						version: 1 as const,
						requestId: 'get',
						method: 'getRun' as const,
						params: { runId: 'run' },
					};
					const listed = yield* dispatcher
						.processRequest(list, undefined)
						.pipe(Effect.flatMap(decodeRunListResponse));
					const fetched = yield* dispatcher
						.processRequest(get, undefined)
						.pipe(Effect.flatMap(decodeRunResponse));
					expect(listed[0]).toEqual(fetched);
					expect(fetched.services[0]?.children).toEqual([
						{ name: 'postgres', ports: { sql: 5432 } },
					]);
					yield* dispatcher.processRequest(
						{ ...report, params: { ...report.params, ports: { sql: 5433 } } },
						undefined,
					);
					expect(live.children).toEqual([
						{ name: 'postgres', ports: { sql: 5433 } },
					]);
					yield* dispatcher.processRequest(
						{
							...report,
							params: { ...report.params, instanceId: 'old', name: 'stale' },
						},
						undefined,
					);
					expect(live.children).toHaveLength(1);
					yield* dispatcher.processRequest(
						{
							...report,
							method: 'retractService',
							params: {
								runId: 'run',
								service: 'web',
								name: 'postgres',
								instanceId: 'instance',
							},
						},
						undefined,
					);
					expect(
						(yield* dispatcher
							.processRequest(get, undefined)
							.pipe(Effect.flatMap(decodeRunResponse))).services[0],
					).not.toHaveProperty('children');
					yield* dispatcher.processRequest(report, undefined);
					live.exit = { exitCode: 0 };
					expect(
						(yield* dispatcher
							.processRequest(get, undefined)
							.pipe(Effect.flatMap(decodeRunResponse))).services[0],
					).not.toHaveProperty('children');
					terminals.clear();
					yield* dispatcher.processRequest(report, undefined);
					expect(
						(yield* dispatcher
							.processRequest(get, undefined)
							.pipe(Effect.flatMap(decodeRunResponse))).services[0],
					).not.toHaveProperty('children');
					expect(fetched.services[0]).toHaveProperty(
						'memoryBytes',
						15360 * 1024,
					);
					expect(fetched.services[1]).not.toHaveProperty('memoryBytes');
					expect(read).toHaveBeenCalledTimes(1);
					const fileSystem = yield* FileSystem;
					expect(
						yield* fileSystem.readFileString(join(root, 'running.json')),
					).not.toContain('children');
					expect(
						yield* fileSystem.readFileString(join(root, 'running.json')),
					).not.toContain('memoryBytes');
					expect((yield* registry.get('run')).services[0]).not.toHaveProperty(
						'memoryBytes',
					);
					const failing = create(
						makeMemorySampler(
							() => new ProcessError({ message: 'sampler failed' }),
						),
					);
					const failedList = yield* failing
						.processRequest(list, undefined)
						.pipe(Effect.flatMap(decodeRunListResponse));
					const failedGet = yield* failing
						.processRequest(get, undefined)
						.pipe(Effect.flatMap(decodeRunResponse));
					expect(failedList[0]?.services[0]).not.toHaveProperty('memoryBytes');
					expect(failedGet.services[0]).not.toHaveProperty('memoryBytes');
					yield* registry.replace({
						...run,
						state: 'exited',
						services: run.services.map((service) => ({
							...service,
							state: 'exited',
						})),
					});
					const skippedRead = vi.fn(() => Effect.succeed(tree));
					const finished = create(makeMemorySampler(skippedRead));
					yield* finished.processRequest(list, undefined);
					yield* finished.processRequest(get, undefined);
					expect(skippedRead).not.toHaveBeenCalled();
				}),
			),
	);

	it.effect('concurrent callers share one read', () =>
		Effect.gen(function* () {
			const read = vi.fn(() =>
				Effect.sleep('100 millis').pipe(Effect.as(tree)),
			);
			const sample = makeMemorySampler(read, () => 0);
			const results = yield* Effect.all(
				[sample, sample, sample, TestClock.adjust('100 millis')],
				{ concurrency: 'unbounded' },
			);
			expect(read).toHaveBeenCalledTimes(1);
			for (const result of results.slice(0, 3)) expect(result).toBe(tree);
		}),
	);

	it.effect(
		'answers within the wait bound while a slow read finishes in the background',
		() =>
			Effect.gen(function* () {
				let now = 0;
				const slow = Effect.sleep('2 seconds');
				const next = parseProcessTree('300 1 300 S Tue Sep 22 00:00:00 2026 1');
				const read = vi.fn(() => slow.pipe(Effect.as(next)));
				const sample = makeMemorySampler(read, () => now);

				const first = yield* Effect.forkChild(sample);
				yield* TestClock.adjust(`${MEMORY_SAMPLE_MAX_WAIT_MS} millis`);
				expect(yield* Fiber.join(first)).toBeUndefined();

				yield* TestClock.adjust('2 seconds');
				expect(yield* sample).toBe(next);
				expect(read).toHaveBeenCalledTimes(1);

				now = 2000;
				const stale = yield* Effect.forkChild(sample);
				yield* TestClock.adjust(`${MEMORY_SAMPLE_MAX_WAIT_MS} millis`);
				expect(yield* Fiber.join(stale)).toBe(next);
				expect(read).toHaveBeenCalledTimes(2);
			}),
	);

	it.effect(
		'keeps the previous tree after a failed read and backs off before retrying',
		() =>
			Effect.gen(function* () {
				let now = 0;
				let failing = false;
				const read = vi.fn(() =>
					failing
						? Effect.fail(new ProcessError({ message: 'ps too slow' }))
						: Effect.succeed(tree),
				);
				const sample = makeMemorySampler(read, () => now);
				expect(yield* sample).toBe(tree);

				failing = true;
				now = 2000;
				expect(yield* sample).toBe(tree);
				expect(read).toHaveBeenCalledTimes(2);

				now = 3999;
				expect(yield* sample).toBe(tree);
				expect(read).toHaveBeenCalledTimes(2);

				now = 4000;
				failing = false;
				expect(yield* sample).toBe(tree);
				expect(read).toHaveBeenCalledTimes(3);
			}),
	);

	it('formats optional memory compactly and accepts old responses', () => {
		const service = run.services[0];
		if (service === undefined) throw new Error('Missing fixture service');
		expect(
			formatService({ ...service, memoryBytes: 1.25 * 1024 ** 3 }),
		).toContain('running pid 100 1.3 GB');
		expect(formatService(service)).not.toContain(' GB');
		expect(
			formatService({ ...service, state: 'exited', memoryBytes: 1024 ** 3 }),
		).not.toContain(' GB');
	});
});
