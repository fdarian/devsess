import { join } from 'node:path';
import { describe, expect, it } from '@effect/vitest';
import { Effect, Option } from 'effect';
import { FileSystem } from 'effect/FileSystem';
import { formatPresetList } from '../../src/cli/commands/list';
import {
	resolvePreset,
	resolvePresetCandidates,
} from '../../src/cli/preset-resolution';
import { runTest } from '../support/run-test';
import { makeTempDir } from '../support/temp-dir';

describe('CLI available list', () => {
	it.live('resolves project presets without contacting the daemon', () =>
		runTest(
			Effect.gen(function* () {
				const directory = yield* makeTempDir;
				const configPath = join(directory, 'config.json');
				const fileSystem = yield* FileSystem;
				yield* fileSystem.writeFileString(
					configPath,
					JSON.stringify({
						projects: {
							project: {
								matcher: { type: 'path', path: process.cwd() },
								presets: {
									dev: {
										services: {
											web: { command: 'bun dev', cwd: 'apps/web' },
										},
									},
								},
							},
						},
					}),
				);

				const resolved = yield* resolvePresetCandidates({ configPath });
				expect(resolved.configPath).toBe(configPath);
				expect(resolved.matches.matchType).toBe('path');
				expect(
					resolved.candidates.map((candidate) => candidate.presetName),
				).toEqual(['dev']);
				expect(resolved.candidates[0]?.preset.services.web?.command).toBe(
					'bun dev',
				);
				const selected = yield* resolvePreset(
					{ configPath, preset: 'project/dev' },
					false,
				);
				expect(selected.preset.projectName).toBe('project');
				expect(selected.preset.presetName).toBe('dev');
			}),
		),
	);

	it('formats running state and bare-start behavior', () => {
		const resolved = {
			configPath: '/config/devsess.json',
			invocation: {
				invocationCwd: '/work/project',
				canonicalCwd: '/work/project',
			},
			matches: {
				matchType: 'path' as const,
				projects: [],
			},
			projects: [
				{
					projectName: 'project',
					project: {
						matcher: { type: 'path' as const, path: '/work/project' },
						presets: {
							dev: { services: { web: { command: 'bun dev' } } },
						},
					},
				},
			],
			candidates: [
				{
					projectName: 'project',
					presetName: 'dev',
					preset: { services: { web: { command: 'bun dev' } } },
				},
			],
		};
		const lines = formatPresetList(
			resolved,
			Option.some([
				{
					runId: 'run',
					projectName: 'project',
					presetName: 'dev',
					canonicalCwd: '/work/project',
					invocationCwd: '/work/project',
					configSnapshot: {},
					startedAt: '2026-09-22T00:00:00.000Z',
					state: 'running',
					daemon: { pid: 2, processGroupId: 2, startedAt: 'birth' },
					services: [
						{
							name: 'web',
							command: 'bun dev',
							cwd: '/work/project',
							state: 'running',
						},
					],
				},
			]),
			false,
		);
		expect(lines).toContain('  project/dev [running]');
		expect(lines).toContain('Bare start: auto-selects project/dev.');
	});
});
