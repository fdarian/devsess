import { describe, expect, it } from '@effect/vitest';
import { Cause, Effect, Exit, Layer, Option, Queue } from 'effect';
import {
	make as makeTerminal,
	QuitError,
	Terminal,
	type UserInput,
} from 'effect/Terminal';
import { chooseRun } from '../../src/cli/commands/daemon';
import { chooseServices } from '../../src/cli/commands/service-selection';
import { choosePreset } from '../../src/cli/preset-resolution';
import type { RunRecord } from '../../src/cli/registry';
import { runTest } from '../support/run-test';

const run = (runId: string): RunRecord => ({
	runId,
	projectName: 'project',
	presetName: 'default',
	canonicalCwd: '/work/project',
	invocationCwd: '/work/project',
	configSnapshot: {},
	startedAt: '2026-09-23T00:00:00.000Z',
	state: 'running',
	daemon: { pid: 42, processGroupId: 42, startedAt: 'birth' },
	services: [
		{
			name: 'web',
			command: 'sleep 60',
			cwd: '/work/project',
			state: 'running',
		},
		{
			name: 'api',
			command: 'sleep 60',
			cwd: '/work/project',
			state: 'running',
		},
	],
});

const quitTerminal = Layer.succeed(
	Terminal,
	makeTerminal({
		columns: Effect.succeed(80),
		rows: Effect.succeed(24),
		readInput: Effect.gen(function* () {
			const input = yield* Queue.unbounded<UserInput, Cause.Done>();
			yield* Queue.offer(input, {
				input: Option.some('\x03'),
				key: { name: 'c', ctrl: true, meta: false, shift: false },
			});
			yield* Queue.end(input);
			return input;
		}),
		readLine: new QuitError({}),
		display: () => Effect.void,
	}),
);

const expectInterrupted = <A, E>(exit: Exit.Exit<A, E>) => {
	expect(Exit.isFailure(exit)).toBe(true);
	if (Exit.isFailure(exit))
		expect(Cause.hasInterruptsOnly(exit.cause)).toBe(true);
};

describe('picker cancellation', () => {
	it.live('interrupts run, service, and start preset selection on Ctrl-C', () =>
		runTest(
			Effect.gen(function* () {
				const exits = yield* Effect.all({
					run: Effect.exit(
						chooseRun([run('first-run'), run('second-run')], {}, 'tail', true),
					),
					service: Effect.exit(
						chooseServices(run('first-run'), {}, 'tail', true),
					),
					attach: Effect.exit(
						chooseServices(run('first-run'), {}, 'attach', true),
					),
					preset: Effect.exit(
						choosePreset(
							[
								{
									projectName: 'project',
									presetName: 'first',
									preset: { services: { web: { command: 'sleep 60' } } },
								},
								{
									projectName: 'project',
									presetName: 'second',
									preset: { services: { web: { command: 'sleep 60' } } },
								},
							],
							undefined,
							true,
						),
					),
				});
				expectInterrupted(exits.run);
				expectInterrupted(exits.service);
				expectInterrupted(exits.attach);
				expectInterrupted(exits.preset);
			}).pipe(Effect.provide(quitTerminal)),
		),
	);
});
