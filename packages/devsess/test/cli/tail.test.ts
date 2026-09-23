import { NodeTerminal } from '@effect/platform-node';
import { describe, expect, it } from '@effect/vitest';
import { Cause, Effect, Layer, Queue, Runtime } from 'effect';
import { Terminal } from 'effect/Terminal';
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
import { runTest } from '../support/run-test';

const withServices = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
	runTest(
		effect.pipe(
			Effect.provide(
				Layer.effect(
					Terminal,
					NodeTerminal.make(() => false),
				),
			),
		),
	);

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
	const runTailWithExit = (event: DaemonEvent, finished = false) =>
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
			const selected: RunRecord = finished
				? {
						...run,
						state: 'failed',
						services: [
							{
								name: 'web',
								command: 'sleep 30',
								cwd: '/tmp',
								state: 'failed',
								exitCode: 7,
							},
						],
					}
				: run;
			vi.mocked(resolveCurrentRuns).mockReturnValue(
				Effect.succeed({
					location: { dataDirectory: '/tmp/data', socketPath: '/tmp/socket' },
					runs: [selected],
					current: finished ? [] : [selected],
					local: finished ? [] : [selected],
					localRuns: [selected],
				}),
			);
			vi.mocked(chooseRun).mockReturnValue(Effect.succeed(selected));
			vi.mocked(openDaemonStream).mockReturnValue(
				Effect.succeed({ frames }) as never,
			);
			return yield* Effect.exit(tail({}).pipe(Effect.timeout('1 second')));
		});

	it.effect('announces a finished run and returns its saved exit code', () =>
		withServices(
			Effect.gen(function* () {
				const stderr = vi
					.spyOn(process.stderr, 'write')
					.mockImplementation(() => true);
				const result = yield* runTailWithExit(
					{ version: 1, requestId: 'request', event: 'exit', exitCode: 7 },
					true,
				);
				expect(result._tag).toBe('Failure');
				if (result._tag === 'Failure')
					expect(Runtime.getErrorExitCode(Cause.squash(result.cause))).toBe(7);
				expect(stderr).toHaveBeenCalledWith(
					'project/dev [run] is not running; replaying its last output.\n',
				);
			}),
		),
	);

	it.effect('returns success for a zero service exit', () =>
		withServices(
			Effect.gen(function* () {
				const result = yield* runTailWithExit({
					version: 1,
					requestId: 'request',
					event: 'exit',
					exitCode: 0,
				});
				expect(result._tag).toBe('Success');
				expect(resolveCurrentRuns).toHaveBeenCalledWith();
			}),
		),
	);

	it.effect('returns the nonzero service exit code', () =>
		withServices(
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
		),
	);

	it.effect('maps a signal exit to the conventional status', () =>
		withServices(
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
					expect(Runtime.getErrorExitCode(Cause.squash(result.cause))).toBe(
						137,
					);
			}),
		),
	);

	it.effect(
		'waits for every service and keeps completion order for exit codes',
		() =>
			withServices(
				Effect.gen(function* () {
					const framesByService = new Map<
						string,
						Queue.Queue<DaemonStreamFrame>
					>();
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
							exitCode: 4,
						},
					});
					framesByService.set('web', failedFrames);
					framesByService.set('api', slowFrames);
					const web = run.services[0];
					if (web === undefined)
						return yield* Effect.die('Missing web fixture');
					const api = {
						name: 'api',
						command: 'sleep 30',
						cwd: '/tmp',
						state: 'running' as const,
					};
					const multiRun: RunRecord = {
						...run,
						services: [api, web],
					};
					vi.mocked(resolveCurrentRuns).mockReturnValue(
						Effect.succeed({
							location: {
								dataDirectory: '/tmp/data',
								socketPath: '/tmp/socket',
							},
							runs: [multiRun],
							current: [multiRun],
							local: [multiRun],
							localRuns: [multiRun],
						}),
					);
					vi.mocked(chooseRun).mockReturnValue(Effect.succeed(multiRun));
					vi.mocked(openDaemonStream).mockImplementation((options) => {
						const frames = framesByService.get(
							options.request.params.serviceName,
						);
						if (frames === undefined)
							return Effect.die('Missing stream fixture');
						return Effect.succeed({ frames }) as never;
					});
					const output = vi
						.spyOn(process.stdout, 'write')
						.mockImplementation(() => true);
					const result = yield* Effect.exit(tail({ allServices: true }));
					expect(result._tag).toBe('Failure');
					if (result._tag === 'Failure')
						expect(Runtime.getErrorExitCode(Cause.squash(result.cause))).toBe(
							4,
						);
					expect(output).toHaveBeenCalledWith('[api] later output');
				}),
			),
	);
});
