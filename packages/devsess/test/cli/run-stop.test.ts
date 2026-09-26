import { describe, expect, it } from '@effect/vitest';
import { Cause, Effect, Exit, Option } from 'effect';
import { ProcessError } from '../../src/cli/processes';
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
