import { describe, expect, it } from '@effect/vitest';
import { Cause, Effect, Exit, Option } from 'effect';
import { vi } from 'vitest';
import { ProcessError, type ProcessIdentity } from '../../src/cli/processes';
import type { RunRecord } from '../../src/cli/registry';
import { makeRunStop } from '../../src/cli/run-stop';
import { runTest } from '../support/run-test';

describe('stop failures', () => {
	it.effect('includes the service and underlying termination failure', () =>
		runTest(
			Effect.gen(function* () {
				const run: RunRecord = {
					runId: 'run',
					projectName: 'project',
					presetName: 'dev',
					canonicalCwd: '/tmp',
					invocationCwd: '/tmp',
					configSnapshot: {},
					startedAt: '2026-09-22T00:00:00.000Z',
					state: 'running',
					daemon: { pid: 2, processGroupId: 2, startedAt: 'birth' },
					services: [
						{
							name: 'engine',
							command: 'sleep 30',
							cwd: '/tmp',
							state: 'running',
							process: { pid: 3, processGroupId: 3, startedAt: 'birth' },
						},
					],
				};
				const stop = makeRunStop({
					registry: {
						prune: Effect.void,
						get: () => Effect.succeed(run),
						replace: (updated) => Effect.succeed(updated),
						list: Effect.succeed([run]),
						reserve: () => Effect.void,
					},
					processes: {
						groupAlive: () => Effect.succeed(true),
						terminate: () =>
							new ProcessError({
								message: 'Cannot verify process group 3 before signaling',
							}),
					} as never,
					terminals: new Map(),
					output: {} as never,
					subscriptions: {} as never,
				});
				const result = yield* Effect.exit(stop.stopRun('run', false));
				if (Exit.isSuccess(result))
					return yield* Effect.die('Expected stop to fail');
				const error = Option.getOrThrow(Cause.findErrorOption(result.cause));
				expect(error).toMatchObject({
					message: expect.stringContaining(
						'Service engine: Cannot verify process group 3 before signaling',
					),
				});
			}),
		),
	);
});

describe('stop deadline', () => {
	const runningRun = (): RunRecord => ({
		runId: 'run',
		projectName: 'project',
		presetName: 'dev',
		canonicalCwd: '/tmp',
		invocationCwd: '/tmp',
		configSnapshot: {},
		startedAt: '2026-09-22T00:00:00.000Z',
		state: 'running',
		daemon: { pid: 2, processGroupId: 2, startedAt: 'birth' },
		services: [
			{
				name: 'engine',
				command: 'sleep 30',
				cwd: '/tmp',
				state: 'running',
				process: { pid: 3, processGroupId: 3, startedAt: 'birth' },
			},
		],
	});
	/** A stop whose graceful termination never returns, over a group that dies when SIGKILLed. */
	const hungStop = (options: { groupSurvivesKill: boolean }) => {
		let stored = runningRun();
		let alive = true;
		const kill = vi.fn((_identity: ProcessIdentity) =>
			Effect.sync(() => {
				alive = options.groupSurvivesKill;
				return true;
			}),
		);
		const markPersisted = vi.fn(() => Effect.void);
		const stop = makeRunStop({
			deadlineMs: 50,
			registry: {
				prune: Effect.void,
				get: () => Effect.sync(() => stored),
				replace: (updated) =>
					Effect.sync(() => {
						stored = updated;
						return updated;
					}),
				list: Effect.sync(() => [stored]),
				reserve: () => Effect.void,
			},
			processes: {
				groupAlive: () => Effect.sync(() => alive),
				terminate: () => Effect.never,
				kill,
			} as never,
			terminals: new Map(),
			output: {
				awaitIdle: () => Effect.void,
				close: () => Effect.void,
			} as never,
			subscriptions: {
				finishSubscriptions: () => Effect.void,
				markPersisted,
			} as never,
		});
		return { stop, kill, markPersisted, stored: () => stored };
	};

	it.live(
		'kills what remains and settles the run instead of leaving it stopping',
		() =>
			runTest(
				Effect.gen(function* () {
					const hung = hungStop({ groupSurvivesKill: false });
					const stopped = yield* hung.stop.stopRun('run', false);
					expect(hung.kill).toHaveBeenCalledWith({
						pid: 3,
						processGroupId: 3,
						startedAt: 'birth',
					});
					expect(stopped.state).toBe('exited');
					expect(stopped.services[0]).toMatchObject({
						state: 'exited',
						signal: 9,
					});
					expect(hung.stored().services[0]?.state).toBe('exited');
					expect(hung.markPersisted).toHaveBeenCalled();
				}),
			),
	);

	it.live('applies inside an uninterruptible region such as startRun', () =>
		runTest(
			Effect.gen(function* () {
				const hung = hungStop({ groupSurvivesKill: false });
				const stopped = yield* Effect.uninterruptible(
					hung.stop.stopRun('run', false),
				);
				expect(stopped.state).toBe('exited');
			}),
		),
	);

	it.live(
		'reports a group that survives SIGKILL as orphaned, never stopping',
		() =>
			runTest(
				Effect.gen(function* () {
					const hung = hungStop({ groupSurvivesKill: true });
					const result = yield* Effect.exit(hung.stop.stopRun('run', false));
					expect(Exit.isFailure(result)).toBe(true);
					expect(hung.stored().services[0]?.state).toBe('orphaned');
					expect(hung.stored().services[0]?.process?.pid).toBe(3);
					if (Exit.isFailure(result))
						expect(Cause.pretty(result.cause)).toContain('survived SIGKILL');
				}),
			),
	);
});
