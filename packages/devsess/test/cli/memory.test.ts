import { join } from 'node:path';
import { describe, expect, it } from '@effect/vitest';
import { Effect } from 'effect';
import { FileSystem } from 'effect/FileSystem';
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
					const create = (memorySample: ReturnType<typeof makeMemorySampler>) =>
						makeRequestDispatcher({
							registry,
							memorySample,
							terminals: new Map(),
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
					expect(fetched.services[0]).toHaveProperty(
						'memoryBytes',
						15360 * 1024,
					);
					expect(fetched.services[1]).not.toHaveProperty('memoryBytes');
					expect(read).toHaveBeenCalledTimes(1);
					const fileSystem = yield* FileSystem;
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
