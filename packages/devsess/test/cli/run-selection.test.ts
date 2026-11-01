import { NodeTerminal } from '@effect/platform-node';
import { describe, expect, it } from '@effect/vitest';
import { Cause, Effect, Exit, Layer } from 'effect';
import { Terminal } from 'effect/Terminal';
import { chooseRun } from '../../src/cli/commands/daemon';
import { chooseServices } from '../../src/cli/commands/service-selection';
import type { RunRecord } from '../../src/cli/registry';
import { runSelector, shortRunId } from '../../src/cli/run-id';
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
		'accepts a status short ID as the positional selector for attach, tail and stop',
		() =>
			testSelection(
				Effect.gen(function* () {
					const target = run(
						'c585f251-0000-0000-0000-000000000000',
						'mockingbird',
					);
					const elsewhere = run(
						'f73b142a-0000-0000-0000-000000000000',
						'elsewhere',
					);
					for (const command of ['attach', 'tail', 'stop']) {
						const selected = yield* chooseRun(
							[elsewhere, target],
							{ preset: 'c585f251' },
							command,
							false,
							[elsewhere],
						);
						expect(selected.runId).toBe(target.runId);
					}
				}),
			),
	);

	it.live(
		'prefers preset names over run ID prefixes, even across finished runs',
		() =>
			testSelection(
				Effect.gen(function* () {
					const target = run('c585f251-0000-0000-0000-000000000000');
					const preset = {
						...run('elsewhere-0000', 'other'),
						presetName: 'c585f251',
					};
					expect(shortRunId(target, [target, preset])).toBe('c585f251-');
					expect(runSelector(target, [target, preset])).toBe('c585f251-');
					const selected = yield* chooseRun(
						[target, preset],
						{ preset: 'c585f251' },
						'attach',
						false,
						[],
					);
					expect(selected.runId).toBe(preset.runId);
					const byId = yield* chooseRun(
						[target, preset],
						{ preset: 'c585f251-' },
						'attach',
						false,
						[],
					);
					expect(byId.runId).toBe(target.runId);
					const finished = {
						...preset,
						state: 'exited' as const,
						services: preset.services.map((service) => ({
							...service,
							state: 'exited' as const,
						})),
					};
					const replayed = yield* chooseRun(
						[target],
						{ preset: 'c585f251' },
						'tail',
						false,
						[],
						[target, finished],
					);
					expect(replayed.runId).toBe(finished.runId);
				}),
			),
	);

	it.live(
		'uses a positional ID to replay a finished run if no active ID matches',
		() =>
			testSelection(
				Effect.gen(function* () {
					const active = run('active-0000');
					const finished = run(
						'c585f251-0000-0000-0000-000000000000',
						'mockingbird',
						'exited',
					);
					const selected = yield* chooseRun(
						[active],
						{ preset: 'c585f251' },
						'tail',
						false,
						[],
						[active, finished],
					);
					expect(selected.runId).toBe(finished.runId);
				}),
			),
	);

	it.live(
		'rejects an ambiguous finished ID prefix with exact short-ID commands',
		() =>
			testSelection(
				Effect.gen(function* () {
					const first = run(
						'c585f251-a000-0000-0000-000000000000',
						'mockingbird',
						'failed',
					);
					const second = run(
						'c585f251-b000-0000-0000-000000000000',
						'mockingbird',
						'failed',
					);
					const result = yield* Effect.exit(
						chooseRun(
							[],
							{ preset: 'c585f251' },
							'tail',
							false,
							[],
							[first, second],
						),
					);
					if (Exit.isFailure(result)) {
						const message = String(Cause.squash(result.cause));
						expect(message).toContain('Multiple finished runs match c585f251');
						expect(message).toContain('--run c585f251-a');
						expect(message).toContain('--run c585f251-b');
					} else expect.fail('Expected an ambiguous finished prefix');
				}),
			),
	);

	it.live(
		'lists distinct selectors when an active ID prefix is ambiguous',
		() =>
			testSelection(
				Effect.gen(function* () {
					const first = run('c585f251-a000-0000-0000-000000000000');
					const second = run('c585f251-b000-0000-0000-000000000000');
					const result = yield* Effect.exit(
						chooseRun([first, second], { preset: 'c585f251' }, 'stop', false),
					);
					if (Exit.isFailure(result)) {
						const message = String(Cause.squash(result.cause));
						expect(message).toContain('--run c585f251-a');
						expect(message).toContain('--run c585f251-b');
					} else expect.fail('Expected an ambiguous active prefix');
				}),
			),
	);
	it.live(
		'prefers a matching active run, then the newest matching finished run with local preference',
		() =>
			testSelection(
				Effect.gen(function* () {
					const older = {
						...run('older', 'oagent', 'failed'),
						startedAt: '2026-09-21T00:00:00.000Z',
					};
					const newer = {
						...run('newer', 'oagent', 'failed'),
						startedAt: '2026-09-22T00:00:00.000Z',
					};
					const all = [older, newer, run('active')];
					const active = yield* chooseRun(
						all,
						{ preset: 'oagent/default' },
						'tail',
						false,
						[],
						all,
					);
					expect(active.runId).toBe('active');
					const recent = yield* chooseRun(
						[],
						{ preset: 'oagent/default' },
						'tail',
						false,
						[],
						[older, newer],
					);
					expect(recent.runId).toBe('newer');
					const specified = yield* chooseRun(
						[],
						{ project: 'oagent', runId: 'older' },
						'tail',
						false,
						[],
						[older, newer],
					);
					expect(specified.runId).toBe('older');
					const local = yield* chooseRun(
						[],
						{},
						'tail',
						false,
						[older],
						[older, newer],
					);
					expect(local.runId).toBe('older');
				}),
			),
	);
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
						expect(message).toContain(
							'oagent/default [first-1] — /work/oagent started',
						);
						expect(message).toContain(
							'oagent/default [second-2] — /work/oagent started',
						);
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

	it.live('expands colliding short IDs in labels and commands', () =>
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
					expect(message).toContain('oagent/default [same-id-1]');
					expect(message).toContain('oagent/default [same-id-2]');
					expect(message).toContain(
						'devsess stop oagent/default --run same-id-1',
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
					expect(message).toContain('other/default [live]');
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
	it.live('lists checkout paths and IDs for an ambiguous named selector', () =>
		testSelection(
			Effect.gen(function* () {
				const local = run('first-run');
				const remote = {
					...run('second-run'),
					canonicalCwd: '/work/other-checkout',
				};
				for (const options of [
					{ preset: 'oagent/default' },
					{ project: 'oagent' },
				]) {
					const result = yield* Effect.exit(
						chooseRun([local, remote], options, 'stop', false, [local]),
					);
					if (Exit.isFailure(result)) {
						const message = String(Cause.squash(result.cause));
						expect(message).toContain('/work/oagent');
						expect(message).toContain('/work/other-checkout');
						expect(message).toContain('--run first-ru');
						expect(message).toContain('--run second-r');
					} else expect.fail('Expected ambiguous selector');
				}
				const bare = yield* chooseRun([local, remote], {}, 'stop', false, [
					local,
				]);
				expect(bare.runId).toBe(local.runId);
			}),
		),
	);
	it.live('does not guess between finished runs from different checkouts', () =>
		testSelection(
			Effect.gen(function* () {
				const first = run('first-run', 'oagent', 'exited');
				const second = {
					...run('second-run', 'oagent', 'exited'),
					canonicalCwd: '/work/other-checkout',
				};
				const result = yield* Effect.exit(
					chooseRun(
						[],
						{ preset: 'oagent/default' },
						'tail',
						false,
						[],
						[first, second],
					),
				);
				if (Exit.isFailure(result)) {
					const message = String(Cause.squash(result.cause));
					expect(message).toContain(
						'Multiple finished runs match oagent/default',
					);
					expect(message).toContain('/work/oagent');
					expect(message).toContain('/work/other-checkout');
					expect(message).toContain('--run first-ru');
					expect(message).toContain('--run second-r');
				} else expect.fail('Expected ambiguous finished selector');
			}),
		),
	);

	it.live(
		'requires an explicit selector for runs outside the current directory',
		() =>
			testSelection(
				Effect.gen(function* () {
					const elsewhere = run(
						'0079e20e-0000-0000-0000-000000000000',
						'mockingbird',
					);
					const another = run(
						'c585f251-0000-0000-0000-000000000000',
						'elsewhere',
					);
					for (const command of ['tail', 'attach', 'stop']) {
						const result = yield* Effect.exit(
							chooseRun([elsewhere, another], {}, command, true, []).pipe(
								Effect.timeout('1 second'),
							),
						);
						expect(Exit.isFailure(result)).toBe(true);
						if (Exit.isFailure(result)) {
							const message = String(Cause.squash(result.cause));
							expect(message).toContain('Nothing running in this project');
							expect(message).toContain('mockingbird/default [0079e20e]');
							expect(message).toContain('elsewhere/default [c585f251]');
							expect(message).toContain(
								`devsess ${command} mockingbird/default`,
							);
							expect(message).toContain(`devsess ${command} 0079e20e`);
						}
						for (const options of [
							{ preset: 'mockingbird/default' },
							{ project: 'mockingbird' },
							{ preset: '0079e20e' },
						]) {
							const selected = yield* chooseRun(
								[elsewhere, another],
								options,
								command,
								false,
								[],
							);
							expect(selected.runId).toBe(elsewhere.runId);
							expect(selected.selection.local).toBe(false);
						}
					}
				}),
			),
	);

	it.live('replays only a local finished run without a selector', () =>
		testSelection(
			Effect.gen(function* () {
				const remote = run('remote', 'elsewhere', 'failed');
				const local = run('local', 'here', 'failed');
				const selected = yield* chooseRun(
					[],
					{},
					'tail',
					false,
					[local],
					[remote, local],
				);
				expect(selected.runId).toBe('local');
				const result = yield* Effect.exit(
					chooseRun([], {}, 'tail', false, [], [remote]),
				);
				expect(Exit.isFailure(result)).toBe(true);
				if (Exit.isFailure(result))
					expect(String(Cause.squash(result.cause))).toContain(
						'Nothing running in this project',
					);
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
					const qualified = yield* Effect.exit(
						chooseServices(
							{ ...multi, runId: 'c585f251-0000-0000-0000-000000000000' },
							{ runId: 'c585f251' },
							'tail',
							false,
						),
					);
					if (Exit.isFailure(qualified))
						expect(String(Cause.squash(qualified.cause))).toContain(
							'devsess tail oagent/default --run c585f251 --service engine',
						);
					else expect.fail('Expected a service selection error');
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
