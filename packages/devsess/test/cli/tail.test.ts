import { describe, expect, it } from '@effect/vitest';
import { Cause, Effect, Queue, Runtime } from 'effect';
import { afterEach, vi } from 'vitest';
import { chooseRun, resolveCurrentRuns } from '../../src/cli/commands/daemon';
import { tail } from '../../src/cli/commands/tail';
import { ServiceExitError } from '../../src/cli/exit-status';
import type { DaemonEvent } from '../../src/cli/protocol';
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

afterEach(() => {
	vi.restoreAllMocks();
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
	const runTailWithExit = (event: DaemonEvent) =>
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
			yield* Queue.offer(frames, { _tag: 'output', value: event });
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
			return yield* Effect.exit(tail({}).pipe(Effect.timeout('1 second')));
		});

	it.effect('returns success for a zero service exit', () =>
		Effect.gen(function* () {
			const result = yield* runTailWithExit({
				version: 1,
				requestId: 'request',
				event: 'exit',
				exitCode: 0,
			});
			expect(result._tag).toBe('Success');
		}),
	);

	it.effect('returns the nonzero service exit code', () =>
		Effect.gen(function* () {
			const result = yield* runTailWithExit({
				version: 1,
				requestId: 'request',
				event: 'exit',
				exitCode: 7,
			});
			expect(result._tag).toBe('Failure');
			if (result._tag === 'Failure') {
				const error = Cause.squash(result.cause);
				expect(error).toBeInstanceOf(ServiceExitError);
				expect(Runtime.getErrorExitCode(error)).toBe(7);
			}
		}),
	);

	it.effect('maps a signal exit to the conventional status', () =>
		Effect.gen(function* () {
			const result = yield* runTailWithExit({
				version: 1,
				requestId: 'request',
				event: 'exit',
				exitCode: 0,
				signal: 9,
			});
			expect(result._tag).toBe('Failure');
			if (result._tag === 'Failure')
				expect(Runtime.getErrorExitCode(Cause.squash(result.cause))).toBe(137);
		}),
	);

	it.effect('waits for every service before returning the first failure', () =>
		Effect.gen(function* () {
			const framesByService = new Map<string, Queue.Queue<DaemonStreamFrame>>();
			const failedFrames = yield* Queue.unbounded<DaemonStreamFrame>();
			const slowFrames = yield* Queue.unbounded<DaemonStreamFrame>();
			yield* Queue.offer(failedFrames, {
				_tag: 'response',
				value: {
					version: 1,
					requestId: 'failed',
					ok: true,
					result: {},
				},
			});
			yield* Queue.offer(failedFrames, {
				_tag: 'output',
				value: {
					version: 1,
					requestId: 'failed',
					event: 'exit',
					exitCode: 7,
				},
			});
			yield* Queue.offer(slowFrames, {
				_tag: 'response',
				value: {
					version: 1,
					requestId: 'slow',
					ok: true,
					result: {},
				},
			});
			yield* Queue.offer(slowFrames, {
				_tag: 'output',
				value: {
					version: 1,
					requestId: 'slow',
					event: 'output',
					data: 'later output',
					offset: 12,
				},
			});
			yield* Queue.offer(slowFrames, {
				_tag: 'output',
				value: {
					version: 1,
					requestId: 'slow',
					event: 'exit',
					exitCode: 0,
				},
			});
			framesByService.set('web', failedFrames);
			framesByService.set('api', slowFrames);
			const web = run.services[0];
			if (web === undefined) return yield* Effect.die('Missing web fixture');
			const multiRun: RunRecord = {
				...run,
				services: [
					web,
					{ name: 'api', command: 'sleep 30', cwd: '/tmp', state: 'running' },
				],
			};
			vi.mocked(resolveCurrentRuns).mockReturnValue(
				Effect.succeed({
					location: { dataDirectory: '/tmp/data', socketPath: '/tmp/socket' },
					runs: [multiRun],
					current: [multiRun],
				}),
			);
			vi.mocked(chooseRun).mockReturnValue(Effect.succeed(multiRun));
			vi.mocked(openDaemonStream).mockImplementation((options) => {
				const frames = framesByService.get(options.request.params.serviceName);
				if (frames === undefined) return Effect.die('Missing stream fixture');
				return Effect.succeed({ frames }) as never;
			});
			const output = vi
				.spyOn(process.stdout, 'write')
				.mockImplementation(() => true);
			const result = yield* Effect.exit(tail({}));
			expect(result._tag).toBe('Failure');
			if (result._tag === 'Failure')
				expect(Runtime.getErrorExitCode(Cause.squash(result.cause))).toBe(7);
			expect(output).toHaveBeenCalledWith('[api] later output');
		}),
	);
});
