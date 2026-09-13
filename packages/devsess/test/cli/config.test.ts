import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { NodeServices } from '@effect/platform-node';
import { describe, expect, it } from '@effect/vitest';
import { Effect } from 'effect';
import { decodeConfig, defaultConfigPath } from '../../src/cli/config';
import {
	captureInvocation,
	captureInvocationWithGit,
	matchProjects,
	normalizeGitRepo,
} from '../../src/cli/project-matching';
import {
	qualifiedPresets,
	qualifiedProjects,
	resolveServiceCwd,
	selectPreset,
	selectProject,
} from '../../src/cli/selection';

const projectDir = fileURLToPath(new URL('../..', import.meta.url));

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

	it.effect('rejects empty and unsafe identifier keys', () =>
		Effect.gen(function* () {
			const invalidDocuments = [
				{
					projects: {
						'../../escape': {
							matcher: { type: 'path', path: '/work/project' },
							presets: {},
						},
					},
				},
				{
					projects: {
						project: {
							matcher: { type: 'path', path: '/work/project' },
							presets: {
								'../../escape': { services: {} },
							},
						},
					},
				},
				{
					projects: {
						project: {
							matcher: { type: 'path', path: '/work/project' },
							presets: {
								dev: {
									services: {
										'../../escape': { command: 'bun dev' },
									},
								},
							},
						},
					},
				},
			];
			for (const document of invalidDocuments) {
				const exit = yield* Effect.exit(decodeConfig(JSON.stringify(document)));
				expect(exit._tag).toBe('Failure');
			}
		}),
	);

	it.effect('rejects empty command and cwd values', () =>
		Effect.gen(function* () {
			const exit = yield* Effect.exit(
				decodeConfig(
					JSON.stringify({
						projects: {
							project: {
								matcher: { type: 'path', path: '/work/project' },
								presets: {
									dev: {
										services: { app: { command: '', cwd: '' } },
									},
								},
							},
						},
					}),
				),
			);
			expect(exit._tag).toBe('Failure');
		}),
	);

	it.effect('rejects unknown configuration fields at every level', () =>
		Effect.gen(function* () {
			const exit = yield* Effect.exit(
				decodeConfig(
					JSON.stringify({
						projects: {
							project: {
								matcher: { type: 'path', path: '/work/project' },
								presets: { dev: { services: {} } },
								extraProjectField: true,
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
	it.effect('prefers the longest matching canonical path over git repo', () =>
		Effect.gen(function* () {
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
							matcher: { type: 'git', repo: 'git@example.test:project.git' },
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

	it.effect('uses normalized git repo only when no path matcher matches', () =>
		Effect.gen(function* () {
			const config = yield* decodeConfig(
				JSON.stringify({
					projects: {
						gitProject: {
							matcher: {
								type: 'git',
								repo: 'git@example.test:project.git',
							},
							presets: {},
						},
					},
				}),
			);
			const invocation = yield* captureInvocation(
				projectDir,
				'https://example.test/project/',
			);
			const matches = yield* matchProjects(config, invocation);
			expect(matches.matchType).toBe('git');
			expect(matches.projects.map((project) => project.projectName)).toEqual([
				'gitProject',
			]);
		}),
	);

	it.live('discovers the local Git origin before matching a project', () =>
		Effect.gen(function* () {
			const config = yield* decodeConfig(
				JSON.stringify({
					projects: {
						devsess: {
							matcher: { type: 'git', repo: 'fdarian/devsess' },
							presets: {},
						},
					},
				}),
			);
			const invocation = yield* captureInvocationWithGit(projectDir);
			const matches = yield* matchProjects(config, invocation);
			expect(matches.matchType).toBe('git');
			expect(matches.projects.map((project) => project.projectName)).toEqual([
				'devsess',
			]);
		}).pipe(Effect.provide(NodeServices.layer)),
	);

	it.effect(
		'matches a shorthand configured repo against a fuller identity',
		() =>
			Effect.gen(function* () {
				const config = yield* decodeConfig(
					JSON.stringify({
						projects: {
							gitProject: {
								matcher: { type: 'git', repo: 'acme/project' },
								presets: {},
							},
						},
					}),
				);
				const invocation = yield* captureInvocation(
					projectDir,
					'https://github.com/acme/project.git',
				);
				const matches = yield* matchProjects(config, invocation);
				expect(matches.matchType).toBe('git');
				expect(matches.projects.map((project) => project.projectName)).toEqual([
					'gitProject',
				]);
			}),
	);

	it.effect('matches a host-qualified configured repo exactly', () =>
		Effect.gen(function* () {
			const config = yield* decodeConfig(
				JSON.stringify({
					projects: {
						gitProject: {
							matcher: { type: 'git', repo: 'github.com/acme/project' },
							presets: {},
						},
					},
				}),
			);
			const invocation = yield* captureInvocation(
				projectDir,
				'git@github.com:acme/project.git',
			);
			const matches = yield* matchProjects(config, invocation);
			expect(matches.matchType).toBe('git');
			expect(matches.projects.map((project) => project.projectName)).toEqual([
				'gitProject',
			]);
		}),
	);

	it.effect(
		'matches host-qualified repos across the supported remote forms',
		() =>
			Effect.gen(function* () {
				const config = yield* decodeConfig(
					JSON.stringify({
						projects: {
							gitProject: {
								matcher: { type: 'git', repo: 'github.com/acme/project' },
								presets: {},
							},
						},
					}),
				);
				for (const repo of [
					'git@github.com:acme/project.git',
					'https://github.com/acme/project',
					'https://github.com/acme/project.git',
					'ssh://git@github.com/acme/project',
					'ssh://git@github.com/acme/project.git',
				]) {
					const invocation = yield* captureInvocation(projectDir, repo);
					const matches = yield* matchProjects(config, invocation);
					expect(matches.matchType).toBe('git');
					expect(
						matches.projects.map((project) => project.projectName),
					).toEqual(['gitProject']);
				}
			}),
	);

	it.effect('does not let a host-qualified matcher cross hosts', () =>
		Effect.gen(function* () {
			const config = yield* decodeConfig(
				JSON.stringify({
					projects: {
						gitProject: {
							matcher: { type: 'git', repo: 'github.com/acme/project' },
							presets: {},
						},
					},
				}),
			);
			const invocation = yield* captureInvocation(
				projectDir,
				'https://evil.example/github.com/acme/project.git',
			);
			const matches = yield* matchProjects(config, invocation);
			expect(matches).toEqual({ matchType: 'none', projects: [] });
		}),
	);

	it.effect('keeps hostless shorthand suffix matching', () =>
		Effect.gen(function* () {
			const config = yield* decodeConfig(
				JSON.stringify({
					projects: {
						gitProject: {
							matcher: { type: 'git', repo: 'acme/project' },
							presets: {},
						},
					},
				}),
			);
			const invocation = yield* captureInvocation(
				projectDir,
				'https://evil.example/github.com/acme/project.git',
			);
			const matches = yield* matchProjects(config, invocation);
			expect(matches.matchType).toBe('git');
			expect(matches.projects.map((project) => project.projectName)).toEqual([
				'gitProject',
			]);
		}),
	);

	it.effect(
		'does not let a shorthand match land mid-segment across a `/` boundary',
		() =>
			Effect.gen(function* () {
				const config = yield* decodeConfig(
					JSON.stringify({
						projects: {
							gitProject: {
								matcher: { type: 'git', repo: 'me/project' },
								presets: {},
							},
						},
					}),
				);
				const invocation = yield* captureInvocation(
					projectDir,
					'https://github.com/acme/project.git',
				);
				const matches = yield* matchProjects(config, invocation);
				expect(matches).toEqual({ matchType: 'none', projects: [] });
			}),
	);

	it.effect('does not match two genuinely different repos', () =>
		Effect.gen(function* () {
			const config = yield* decodeConfig(
				JSON.stringify({
					projects: {
						gitProject: {
							matcher: { type: 'git', repo: 'acme/other-project' },
							presets: {},
						},
					},
				}),
			);
			const invocation = yield* captureInvocation(
				projectDir,
				'https://github.com/acme/project.git',
			);
			const matches = yield* matchProjects(config, invocation);
			expect(matches).toEqual({ matchType: 'none', projects: [] });
		}),
	);

	it.effect('treats a missing configured matcher path as a nonmatch', () =>
		Effect.gen(function* () {
			const rootDir = projectDir;
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

	it.effect(
		'normalizes every remote spelling to the same host/owner/repo identity',
		() =>
			Effect.sync(() => {
				expect(normalizeGitRepo('git@github.com:acme/project.git')).toBe(
					'github.com/acme/project',
				);
				expect(normalizeGitRepo('ssh://git@github.com/acme/project.git')).toBe(
					'github.com/acme/project',
				);
				expect(normalizeGitRepo('https://github.com/acme/project/')).toBe(
					'github.com/acme/project',
				);
				expect(normalizeGitRepo('github.com/acme/project')).toBe(
					'github.com/acme/project',
				);
			}),
	);

	it.effect('lowercases the normalized identity', () =>
		Effect.sync(() => {
			expect(normalizeGitRepo('git@GitHub.com:Acme/Project.git')).toBe(
				'github.com/acme/project',
			);
		}),
	);

	it.effect('does not normalize two different repos to the same identity', () =>
		Effect.sync(() => {
			expect(normalizeGitRepo('github.com/acme/project')).not.toBe(
				normalizeGitRepo('github.com/acme/other-project'),
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
								matcher: { type: 'git', repo: 'git@example.test:alpha.git' },
								presets: {
									dev: { services: { app: { command: 'bun dev' } } },
								},
							},
							beta: {
								matcher: { type: 'git', repo: 'git@example.test:beta.git' },
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
							matcher: { type: 'git', repo: 'github.com/acme/project' },
							presets: {},
						},
						alpha: {
							matcher: { type: 'git', repo: 'github.com/acme/project' },
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
