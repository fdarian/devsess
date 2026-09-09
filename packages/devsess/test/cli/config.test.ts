import { join } from 'node:path';
import { describe, expect, it } from '@effect/vitest';
import { Effect } from 'effect';
import { decodeConfig, defaultConfigPath } from '../../src/cli/config';
import {
	captureInvocation,
	matchProjects,
	normalizeGitOrigin,
} from '../../src/cli/project-matching';
import {
	qualifiedProjects,
	qualifiedPresets,
	resolveServiceCwd,
	selectProject,
	selectPreset,
} from '../../src/cli/selection';

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

const requireDefined = <T>(value: T | undefined, label: string) =>
	value === undefined
		? Effect.die(`Expected ${label} to be defined`)
		: Effect.succeed(value);

describe('CLI configuration', () => {
	it.effect(
		'decodes the minimal global config and preserves optional service cwd',
		() =>
			Effect.gen(function* () {
				const config = yield* decodeConfig(configJson);
				const alpha = yield* requireDefined(
					config.projects.alpha,
					'alpha project',
				);
				const web = yield* requireDefined(alpha.presets.web, 'web preset');
				const app = yield* requireDefined(web.services.app, 'app service');
				expect(app.command).toBe('bun run dev');
				expect(app.cwd).toBe('apps/web');
			}),
	);

	it.effect(
		'uses XDG_CONFIG_HOME when supplied and otherwise follows XDG defaults',
		() =>
			Effect.sync(() => {
				expect(defaultConfigPath('/home/dev')).toBe(
					'/home/dev/.config/devsess/config.json',
				);
				expect(defaultConfigPath('/home/dev', '/var/config')).toBe(
					'/var/config/devsess/config.json',
				);
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

	it.effect('rejects relative project path matchers', () =>
		Effect.gen(function* () {
			const exit = yield* Effect.exit(
				decodeConfig(
					JSON.stringify({
						projects: {
							alpha: {
								matcher: { type: 'path', path: 'relative/project' },
								presets: {},
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
			const rootDir = process.cwd();
			const projectDir = join(rootDir, 'packages', 'devsess');
			const appDir = join(projectDir, 'src');
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
			const projectDir = join(process.cwd(), 'packages', 'devsess');
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

	it.effect('uses normalized git origin only when no path matcher matches', () =>
		Effect.gen(function* () {
			const config = yield* decodeConfig(
				JSON.stringify({
					projects: {
						gitProject: {
							matcher: {
								type: 'git',
								origin: 'git@example.test:project.git',
							},
							presets: {},
						},
					},
				}),
			);
			const invocation = yield* captureInvocation(
				process.cwd(),
				'https://example.test/project/',
			);
			const matches = yield* matchProjects(config, invocation);
			expect(matches.matchType).toBe('git');
			expect(matches.projects.map((project) => project.projectName)).toEqual([
				'gitProject',
			]);
		}),
	);

	it.effect('treats a missing configured matcher path as a nonmatch', () =>
		Effect.gen(function* () {
			const rootDir = process.cwd();
			const config = yield* decodeConfig(
				JSON.stringify({
					projects: {
						missing: {
							matcher: { type: 'path', path: join(rootDir, 'missing') },
							presets: {},
						},
					},
				}),
			);
			const invocation = yield* captureInvocation(rootDir);
			const matches = yield* matchProjects(config, invocation);
			expect(matches).toEqual({ matchType: 'none', projects: [] });
		}),
	);

	it.effect('normalizes equivalent SSH and HTTPS git origins', () =>
		Effect.sync(() => {
			expect(normalizeGitOrigin('git@github.com:acme/project.git')).toBe(
				'github.com/acme/project',
			);
			expect(normalizeGitOrigin('https://github.com/acme/project/')).toBe(
				'github.com/acme/project',
			);
			expect(normalizeGitOrigin('ssh://git@github.com/acme/project.git')).toBe(
				'github.com/acme/project',
			);
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
				const alpha = yield* requireDefined(
					config.projects.alpha,
					'alpha project',
				);
				const beta = yield* requireDefined(
					config.projects.beta,
					'beta project',
				);
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
				const invocation = {
					invocationCwd: '/work/invoked',
					canonicalCwd: '/work/invoked-canonical',
				};
				const alphaPreset = yield* requireDefined(
					alpha.presets.dev,
					'alpha preset',
				);
				const betaPreset = yield* requireDefined(
					beta.presets.dev,
					'beta preset',
				);
				const alphaApp = yield* requireDefined(
					alphaPreset.services.app,
					'alpha app',
				);
				const betaApp = yield* requireDefined(
					betaPreset.services.app,
					'beta app',
				);
				expect(resolveServiceCwd(alphaApp, invocation)).toBe('/work/invoked');
				expect(resolveServiceCwd(betaApp, invocation)).toBe(
					'/work/invoked/apps/web',
				);
			}),
	);

	it.effect('selects a requested project and exposes qualified ambiguity', () =>
		Effect.gen(function* () {
			const config = yield* decodeConfig(
				JSON.stringify({
					projects: {
						zebra: {
							matcher: { type: 'git', origin: 'github.com/acme/project' },
							presets: {},
						},
						alpha: {
							matcher: { type: 'git', origin: 'github.com/acme/project' },
							presets: {},
						},
					},
				}),
			);
			const alpha = yield* requireDefined(
				config.projects.alpha,
				'alpha project',
			);
			const zebra = yield* requireDefined(
				config.projects.zebra,
				'zebra project',
			);
			const candidates = qualifiedProjects([
				{ projectName: 'zebra', project: zebra },
				{ projectName: 'alpha', project: alpha },
			]);
			expect(candidates.map((candidate) => candidate.projectName)).toEqual([
				'alpha',
				'zebra',
			]);
			const ambiguous = selectProject(candidates);
			expect(ambiguous._tag).toBe('AmbiguousProject');
			const selection = selectProject(candidates, 'zebra');
			expect(selection._tag).toBe('SelectedProject');
			if (selection._tag === 'SelectedProject') {
				expect(selection.project.projectName).toBe('zebra');
			}
		}),
	);
});
