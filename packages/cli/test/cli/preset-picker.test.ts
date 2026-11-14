import { describe, expect, it } from '@effect/vitest';
import { type Cause, Effect, Layer, Option, Queue } from 'effect';
import {
	make as makeTerminal,
	QuitError,
	Terminal,
	type UserInput,
} from 'effect/Terminal';
import {
	byRecentUse,
	choosePreset,
	presetLabel,
} from '../../src/cli/preset-resolution';
import type { QualifiedPreset } from '../../src/cli/selection';
import { runTest } from '../support/run-test';

const preset = (projectName: string, presetName: string): QualifiedPreset => ({
	projectName,
	presetName,
	preset: { services: { web: { command: 'sleep 60' } } },
});

const started = (
	projectName: string,
	presetName: string,
	startedAt: string,
) => ({
	projectName,
	presetName,
	startedAt,
});

const scriptedTerminal = (keys: ReadonlyArray<UserInput>) =>
	Layer.succeed(
		Terminal,
		makeTerminal({
			columns: Effect.succeed(80),
			rows: Effect.succeed(24),
			readInput: Effect.gen(function* () {
				const input = yield* Queue.unbounded<UserInput, Cause.Done>();
				yield* Queue.offerAll(input, keys);
				yield* Queue.end(input);
				return input;
			}),
			readLine: new QuitError({}),
			display: () => Effect.void,
		}),
	);

const key = (name: string, ctrl: boolean): UserInput => ({
	input: ctrl ? Option.none() : Option.some(name),
	key: { name, ctrl, meta: false, shift: false },
});

describe('preset picker', () => {
	it('orders presets by their latest start, leaving unused ones in config order', () => {
		const browser = preset('nisi', 'browser');
		const desktop = preset('nisi', 'desktop');
		const storybook = preset('nisi', 'storybook');
		const ordered = byRecentUse(
			[browser, desktop, storybook],
			[
				started('nisi', 'browser', '2026-10-01T00:00:00.000Z'),
				started('nisi', 'desktop', '2026-10-09T00:00:00.000Z'),
				started('nisi', 'browser', '2026-09-01T00:00:00.000Z'),
				started('other', 'storybook', '2026-10-10T00:00:00.000Z'),
			],
		);
		expect(ordered).toEqual([desktop, browser, storybook]);
	});

	it('qualifies only preset names that collide across projects', () => {
		const candidates = [
			preset('api', 'dev'),
			preset('web', 'dev'),
			preset('web', 'storybook'),
		];
		expect(
			candidates.map((candidate) => presetLabel(candidate, candidates)),
		).toEqual(['api/dev', 'web/dev', 'storybook']);
	});

	it.live('moves through presets with Ctrl-N and Ctrl-P', () =>
		runTest(
			Effect.gen(function* () {
				const selected = yield* choosePreset(
					[
						preset('nisi', 'browser'),
						preset('nisi', 'desktop'),
						preset('nisi', 'storybook'),
					],
					undefined,
					true,
					Effect.succeed([]),
				).pipe(
					Effect.provide(
						scriptedTerminal([
							key('n', true),
							key('n', true),
							key('p', true),
							key('return', false),
						]),
					),
				);
				expect(selected.presetName).toBe('desktop');
			}),
		),
	);
});
