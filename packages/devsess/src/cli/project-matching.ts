import { realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, relative, resolve } from 'node:path';
import { Effect, Schema } from 'effect';
import type { ConfigProject, DevsessConfig } from './config';

export class ProjectPathResolutionError extends Schema.TaggedErrorClass<ProjectPathResolutionError>()(
	'ProjectPathResolutionError',
	{
		path: Schema.String,
		cause: Schema.Defect(),
	},
) {}

export type Invocation = {
	canonicalCwd: string;
	gitOrigin?: string;
};

export type MatchedProject = {
	projectName: string;
	project: ConfigProject;
};

export type ProjectMatches = {
	matchType: 'path' | 'git' | 'none';
	projects: ReadonlyArray<MatchedProject>;
};

const expandHome = (path: string) => {
	if (path === '~') {
		return homedir();
	}
	if (path.startsWith('~/')) {
		return resolve(homedir(), path.slice(2));
	}
	return path;
};

const canonicalPath = (path: string, basePath: string) =>
	Effect.try({
		try: () => realpathSync(resolve(basePath, expandHome(path))),
		catch: (cause) => new ProjectPathResolutionError({ path, cause }),
	});

/** Captures the real path used by a start invocation before daemon work begins. */
export const captureInvocation = (cwd: string, gitOrigin?: string) =>
	canonicalPath(cwd, process.cwd()).pipe(
		Effect.map((canonicalCwd): Invocation => ({ canonicalCwd, gitOrigin })),
	);

const isPathMatch = (projectPath: string, invocationPath: string) => {
	const pathFromProject = relative(projectPath, invocationPath);
	return (
		pathFromProject === '' ||
		(!pathFromProject.startsWith('../') &&
			pathFromProject !== '..' &&
			!isAbsolute(pathFromProject))
	);
};

const namedProjects = (config: DevsessConfig) =>
	Object.keys(config.projects)
		.sort((left, right) => left.localeCompare(right))
		.flatMap((projectName): Array<MatchedProject> => {
			const project = config.projects[projectName];
			return project === undefined ? [] : [{ projectName, project }];
		});

/**
 * Resolves path matchers first. The complete equal-longest set is returned so a
 * caller can request a qualified choice instead of inheriting config key order.
 */
export const matchProjects = (config: DevsessConfig, invocation: Invocation) =>
	Effect.gen(function* () {
		const pathMatches: Array<{ project: MatchedProject; pathLength: number }> =
			[];
		for (const project of namedProjects(config)) {
			if (project.project.matcher.type !== 'path') {
				continue;
			}
			const projectPath = yield* canonicalPath(
				project.project.matcher.path,
				invocation.canonicalCwd,
			);
			if (isPathMatch(projectPath, invocation.canonicalCwd)) {
				pathMatches.push({ project, pathLength: projectPath.length });
			}
		}

		if (pathMatches.length > 0) {
			const longestPath = Math.max(
				...pathMatches.map((candidate) => candidate.pathLength),
			);
			return {
				matchType: 'path' as const,
				projects: pathMatches
					.filter((candidate) => candidate.pathLength === longestPath)
					.map((candidate) => candidate.project),
			};
		}

		const gitMatches = namedProjects(config).filter((project) =>
			project.project.matcher.type === 'git' &&
			invocation.gitOrigin !== undefined
				? project.project.matcher.origin === invocation.gitOrigin
				: false,
		);
		return {
			matchType: gitMatches.length > 0 ? ('git' as const) : ('none' as const),
			projects: gitMatches,
		};
	});
