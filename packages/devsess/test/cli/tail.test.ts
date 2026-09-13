import { describe, expect, it } from '@effect/vitest';
import { Effect, Queue } from 'effect';
import { vi } from 'vitest';
import { chooseRun, resolveCurrentRuns } from '../../src/cli/commands/daemon';
import { tail } from '../../src/cli/commands/tail';
import type { RunRecord } from '../../src/cli/registry';
import {
	type DaemonStreamFrame,
	openDaemonStream,
} from '../../src/cli/terminal';

vi.mock('../../src/cli/terminal', () => ({
	openDaemonStream: vi.fn(),
}));
vi.mock('../../src/cli/commands/daemon', async (importOriginal) => {
	const actual =
		await importOriginal<typeof import('../../src/cli/commands/daemon')>();
	return {
		...actual,
		chooseRun: vi.fn(),
		resolveCurrentRuns: vi.fn(),
	};
});

const run: RunRecord = {
	runId: 'run',
	projectName: 'project',
	presetName: 'dev',
	canonicalCwd: '/tmp',
	invocationCwd: '/tmp',
	configSnapshot: {},
	startedAt: '2026-09-09T00:00:00.000Z',
	state: 'running',
	daemon: { pid: 123, processGroupId: 123, startedAt: 'birth' },
	services: [
		{ name: 'web', command: 'sleep 30', cwd: '/tmp', state: 'running' },
	],
};

describe('tail command', () => {
	it.effect('exits normally after receiving a service exit event', () =>
		Effect.gen(function* () {
			const frames = yield* Queue.unbounded<DaemonStreamFrame>();
			yield* Queue.offer(frames, {
				_tag: 'response',
				value: {
					version: 1,
					requestId: 'request',
					ok: true,
					result: {},
				},
			});
			yield* Queue.offer(frames, {
				_tag: 'output',
				value: {
					version: 1,
					requestId: 'request',
					event: 'exit',
					exitCode: 0,
				},
			});
			vi.mocked(resolveCurrentRuns).mockReturnValue(
				Effect.succeed({
					location: { dataDirectory: '/tmp/data', socketPath: '/tmp/socket' },
					runs: [run],
					current: [run],
				}),
			);
			vi.mocked(chooseRun).mockReturnValue(Effect.succeed(run));
			vi.mocked(openDaemonStream).mockReturnValue(
				Effect.succeed({ frames }) as never,
			);
			yield* tail({}).pipe(Effect.timeout('1 second'));
			expect(openDaemonStream).toHaveBeenCalledOnce();
		}),
	);
});
