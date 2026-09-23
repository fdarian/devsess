import { NodeTerminal } from '@effect/platform-node';
import { describe, expect, it } from '@effect/vitest';
import { Cause, Effect, Exit, Layer } from 'effect';
import { Terminal } from 'effect/Terminal';
import { chooseRun } from '../../src/cli/commands/daemon';
import { chooseServices } from '../../src/cli/commands/service-selection';
import type { RunRecord } from '../../src/cli/registry';
import { runTest } from '../support/run-test';

const run = (
	runId: string,
	projectName = 'oagent',
	state: RunRecord['services'][number]['state'] = 'running',
): RunRecord => ({
	runId,
	projectName,
	presetName: 'default',
	canonicalCwd: '/work/oagent',
	invocationCwd: '/work/oagent',
	configSnapshot: {},
	startedAt: '2026-09-23T00:00:00.000Z',
	state,
	daemon: { pid: 42, processGroupId: 42, startedAt: 'birth' },
	services: [
		{ name: 'engine', command: 'bun dev', cwd: '/work/oagent', state },
	],
});

const testSelection = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
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

describe('running session selection', () => {
	it.live(
		'excludes stale records and resolves the qualified argument with flags without prompting',
		() =>
			testSelection(
				Effect.gen(function* () {
					const selected = yield* chooseRun(
						[
							run('stale-1', 'oagent', 'exited'),
							run('stale-2', 'oagent', 'failed'),
							run('active-1'),
						],
						{ project: 'oagent', preset: 'oagent/default', service: 'engine' },
						'tail',
						true,
					).pipe(Effect.timeout('1 second'));
					expect(selected.runId).toBe('active-1');
					const services = yield* chooseServices(
						selected,
						{ service: 'engine' },
						'tail',
						true,
					);
					expect(services.map((service) => service.name)).toEqual(['engine']);
				}),
			),
	);

	it.live(
		'disambiguates duplicate active names by run id and offers exact commands',
		() =>
			testSelection(
				Effect.gen(function* () {
					const result = yield* Effect.exit(
						chooseRun(
							[
								run('first-1'),
								run('second-2'),
								run('old-3', 'oagent', 'exited'),
							],
							{},
							'tail',
							false,
						),
					);
					expect(Exit.isFailure(result)).toBe(true);
					if (Exit.isFailure(result)) {
						const message = String(Cause.squash(result.cause));
						expect(message).toContain('oagent/default [first-1] started');
						expect(message).toContain('oagent/default [second-2] started');
						expect(message).toContain(
							'devsess tail oagent/default --run first-1',
						);
						expect(message).not.toContain('old-3');
					}
					const selected = yield* chooseRun(
						[run('first-1'), run('second-2')],
						{ preset: 'oagent/default', runId: 'second' },
						'tail',
						false,
					);
					expect(selected.runId).toBe('second-2');
				}),
			),
	);

	it.live(
		'expands colliding short IDs while keeping full IDs in commands',
		() =>
			testSelection(
				Effect.gen(function* () {
					const result = yield* Effect.exit(
						chooseRun(
							[run('same-id-111'), run('same-id-222')],
							{},
							'stop',
							false,
						),
					);
					if (Exit.isFailure(result)) {
						const message = String(Cause.squash(result.cause));
						expect(message).toContain('oagent/default [same-id-111]');
						expect(message).toContain('oagent/default [same-id-222]');
						expect(message).toContain(
							'devsess stop oagent/default --run same-id-111',
						);
					} else expect.fail('Expected duplicate runs to require selection');
				}),
			),
	);

	it.live('reports live choices and status on no match', () =>
		testSelection(
			Effect.gen(function* () {
				const result = yield* Effect.exit(
					chooseRun(
						[run('old', 'oagent', 'exited'), run('live', 'other')],
						{ preset: 'oagent/default' },
						'attach',
						false,
					),
				);
				if (Exit.isFailure(result)) {
					const message = String(Cause.squash(result.cause));
					expect(message).toContain('Nothing running matches oagent/default');
					expect(message).toContain('other/default');
					expect(message).toContain('devsess status');
				} else expect.fail('Expected a selection error');
			}),
		),
	);

	it.live('finds runs started outside the current directory', () =>
		testSelection(
			Effect.gen(function* () {
				const selected = yield* chooseRun(
					[run('elsewhere')],
					{ project: 'oagent', preset: 'default' },
					'tail',
					false,
					[],
				).pipe(Effect.timeout('1 second'));
				expect(selected.runId).toBe('elsewhere');
			}),
		),
	);

	it.live(
		'prefers runs under the current directory when no project is named',
		() =>
			testSelection(
				Effect.gen(function* () {
					const local = run('local-run', 'here');
					const selected = yield* chooseRun(
						[run('elsewhere', 'there'), local],
						{},
						'tail',
						false,
						[local],
					).pipe(Effect.timeout('1 second'));
					expect(selected.runId).toBe('local-run');
				}),
			),
	);

	it.live('uses project and service flags to skip both pickers', () =>
		testSelection(
			Effect.gen(function* () {
				const selected = yield* chooseRun(
					[run('other-run', 'other'), run('oagent-run')],
					{ project: 'oagent', preset: 'default' },
					'tail',
					true,
				).pipe(Effect.timeout('1 second'));
				expect(selected.runId).toBe('oagent-run');
				const services = yield* chooseServices(
					{
						...selected,
						services: [
							...selected.services,
							{
								name: 'web',
								command: 'bun web',
								cwd: '/work/oagent',
								state: 'running',
							},
						],
					},
					{ service: 'engine' },
					'tail',
					true,
				).pipe(Effect.timeout('1 second'));
				expect(services.map((service) => service.name)).toEqual(['engine']);
			}),
		),
	);

	it.live(
		'lists exact service flags non-interactively and skips the single-service picker',
		() =>
			testSelection(
				Effect.gen(function* () {
					const multi = {
						...run('active'),
						services: [
							{
								name: 'engine',
								command: 'bun engine',
								cwd: '/work/oagent',
								state: 'running' as const,
							},
							{
								name: 'web',
								command: 'bun web',
								cwd: '/work/oagent',
								state: 'running' as const,
							},
						],
					};
					const result = yield* Effect.exit(
						chooseServices(multi, {}, 'attach', false),
					);
					if (Exit.isFailure(result)) {
						const message = String(Cause.squash(result.cause));
						expect(message).toContain(
							'devsess attach oagent/default --service engine',
						);
						expect(message).toContain(
							'devsess attach oagent/default --service web',
						);
					} else expect.fail('Expected a service selection error');
					const tail = yield* Effect.exit(
						chooseServices(multi, {}, 'tail', false),
					);
					if (Exit.isFailure(tail))
						expect(String(Cause.squash(tail.cause))).toContain(
							'--all-services',
						);
					else expect.fail('Expected a tail selection error');
					const selected = yield* chooseServices(
						run('only'),
						{},
						'attach',
						true,
					).pipe(Effect.timeout('1 second'));
					expect(selected.map((service) => service.name)).toEqual(['engine']);
				}),
			),
	);
});
