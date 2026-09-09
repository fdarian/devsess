import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from '@effect/vitest';
import { Effect } from 'effect';
import { decodeConfig } from '../../src/cli/config';
import {
	captureInvocation,
	matchProjects,
} from '../../src/cli/project-matching';
import {
	qualifiedPresets,
	resolveServiceCwd,
	selectPreset,
} from '../../src/cli/selection';
import { makeTempDir } from '../support/temp-dir';

const configJson = JSON.stringify({
	projects: {
		alpha: {
			matcher: { type: 'path', path: '/work/alpha' },
			presets: {
				web: {
					services: {
						app: { command: 'bun run dev', cwd: 'apps/web' },
					},
				},
			},
		},
	},
});

describe('CLI configuration', () => {
	it.effect(
		'decodes the minimal global config and preserves optional service cwd',
		() =>
			Effect.gen(function* () {
				const config = yield* decodeConfig(configJson);
				const alpha = config.projects.alpha;
				expect(alpha).toBeDefined();
				if (alpha === undefined) {
					return;
				}
				const web = alpha.presets.web;
				expect(web).toBeDefined();
				if (web === undefined) {
					return;
				}
				const app = web.services.app;
				expect(app).toBeDefined();
				if (app === undefined) {
					return;
				}
				expect(app.command).toBe('bun run dev');
				expect(app.cwd).toBe('apps/web');
			}),
	);

	it.effect('rejects a service without its required command', () =>
		Effect.gen(function* () {
			const exit = yield* Effect.exit(
				decodeConfig(
					JSON.stringify({
						projects: {
							alpha: {
								matcher: { type: 'path', path: '/work/alpha' },
								presets: { web: { services: { app: {} } } },
							},
						},
					}),
				),
			);
			expect(exit._tag).toBe('Failure');
		}),
	);
});

describe('project matching', () => {
	it.effect('prefers the longest matching canonical path over git origin', () =>
		Effect.gen(function* () {
			const rootDir = yield* makeTempDir;
			const projectDir = join(rootDir, 'project');
			const appDir = join(projectDir, 'apps', 'web');
			mkdirSync(appDir, { recursive: true });
			const config = yield* decodeConfig(
				JSON.stringify({
					projects: {
						root: {
							matcher: { type: 'path', path: projectDir },
							presets: {},
						},
						web: {
							matcher: { type: 'path', path: appDir },
							presets: {},
						},
						gitFallback: {
							matcher: { type: 'git', origin: 'git@example.test:project.git' },
							presets: {},
						},
					},
				}),
			);
			const invocation = yield* captureInvocation(
				appDir,
				'git@example.test:project.git',
			);
			const matches = yield* matchProjects(config, invocation);
			expect(matches.matchType).toBe('path');
			expect(matches.projects.map((project) => project.projectName)).toEqual([
				'web',
			]);
		}),
	);

	it.effect('returns every equal path match in stable name order', () =>
		Effect.gen(function* () {
			const rootDir = yield* makeTempDir;
			const projectDir = join(rootDir, 'project');
			mkdirSync(projectDir);
			const config = yield* decodeConfig(
				JSON.stringify({
					projects: {
						zebra: {
							matcher: { type: 'path', path: projectDir },
							presets: {},
						},
						alpha: {
							matcher: { type: 'path', path: projectDir },
							presets: {},
						},
					},
				}),
			);
			const invocation = yield* captureInvocation(projectDir);
			const matches = yield* matchProjects(config, invocation);
			expect(matches.projects.map((project) => project.projectName)).toEqual([
				'alpha',
				'zebra',
			]);
		}),
	);

	it.effect('uses git origin only when no path matcher matches', () =>
		Effect.gen(function* () {
			const rootDir = yield* makeTempDir;
			const config = yield* decodeConfig(
				JSON.stringify({
					projects: {
						gitProject: {
							matcher: { type: 'git', origin: 'git@example.test:project.git' },
							presets: {},
						},
					},
				}),
			);
			const invocation = yield* captureInvocation(
				rootDir,
				'git@example.test:project.git',
			);
			const matches = yield* matchProjects(config, invocation);
			expect(matches.matchType).toBe('git');
			expect(matches.projects.map((project) => project.projectName)).toEqual([
				'gitProject',
			]);
		}),
	);
});

describe('preset selection', () => {
	it.effect(
		'keeps duplicate preset names explicit and resolves service cwd from start cwd',
		() =>
			Effect.gen(function* () {
				const config = yield* decodeConfig(
					JSON.stringify({
						projects: {
							alpha: {
								matcher: { type: 'git', origin: 'git@example.test:alpha.git' },
								presets: {
									dev: { services: { app: { command: 'bun dev' } } },
								},
							},
							beta: {
								matcher: { type: 'git', origin: 'git@example.test:beta.git' },
								presets: {
									dev: {
										services: { app: { command: 'bun dev', cwd: 'apps/web' } },
									},
								},
							},
						},
					}),
				);
				const alpha = config.projects.alpha;
				const beta = config.projects.beta;
				expect(alpha).toBeDefined();
				expect(beta).toBeDefined();
				if (alpha === undefined || beta === undefined) {
					return;
				}
				const presets = qualifiedPresets([
					{ projectName: 'alpha', project: alpha },
					{ projectName: 'beta', project: beta },
				]);
				const selection = selectPreset(presets, 'dev');
				expect(selection._tag).toBe('AmbiguousPreset');
				if (selection._tag === 'AmbiguousPreset') {
					expect(
						selection.candidates.map((preset) => preset.projectName),
					).toEqual(['alpha', 'beta']);
				}
				const invocation = { canonicalCwd: '/work/invoked' };
				const alphaPreset = alpha.presets.dev;
				const betaPreset = beta.presets.dev;
				expect(alphaPreset).toBeDefined();
				expect(betaPreset).toBeDefined();
				if (alphaPreset === undefined || betaPreset === undefined) {
					return;
				}
				const alphaApp = alphaPreset.services.app;
				const betaApp = betaPreset.services.app;
				expect(alphaApp).toBeDefined();
				expect(betaApp).toBeDefined();
				if (alphaApp === undefined || betaApp === undefined) {
					return;
				}
				expect(resolveServiceCwd(alphaApp, invocation)).toBe('/work/invoked');
				expect(resolveServiceCwd(betaApp, invocation)).toBe(
					'/work/invoked/apps/web',
				);
			}),
	);
});
