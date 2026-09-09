import { realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, relative, resolve } from 'node:path';
import { Effect, Option, Schema } from 'effect';
import type { ConfigProject, DevsessConfig } from './config';

export class ProjectPathResolutionError extends Schema.TaggedErrorClass<ProjectPathResolutionError>()(
	'ProjectPathResolutionError',
	{
		path: Schema.String,
		cause: Schema.Defect(),
	},
) {}

export type Invocation = {
	invocationCwd: string;
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

const isNodeError = (cause: unknown): cause is NodeJS.ErrnoException =>
	typeof cause === 'object' && cause !== null && 'code' in cause;

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
		Effect.map(
			(canonicalCwd): Invocation => ({
				invocationCwd: cwd,
				canonicalCwd,
				gitOrigin:
					gitOrigin === undefined ? undefined : normalizeGitOrigin(gitOrigin),
			}),
		),
	);

/** Makes equivalent SSH and HTTPS remote spellings comparable. */
export const normalizeGitOrigin = (origin: string) => {
	const trimmedOrigin = origin
		.trim()
		.replace(/\/+$/, '')
		.replace(/\.git$/, '');
	const urlOrigin = trimmedOrigin.match(
		/^(?:https?|ssh):\/\/(?:[^@/]+@)?([^/:]+)(?::\d+)?\/(.+)$/i,
	);
	if (urlOrigin !== null) {
		const host = urlOrigin[1];
		const path = urlOrigin[2];
		if (host === undefined || path === undefined) {
			return trimmedOrigin;
		}
		return `${host.toLowerCase()}/${path}`;
	}
	const scpOrigin = trimmedOrigin.match(/^(?:[^@/:]+@)?([^/:]+):(.+)$/);
	if (scpOrigin !== null) {
		const host = scpOrigin[1];
		const path = scpOrigin[2];
		if (host === undefined || path === undefined) {
			return trimmedOrigin;
		}
		return `${host.toLowerCase()}/${path}`;
	}
	return trimmedOrigin;
};

const canonicalMatcherPath = (path: string, invocation: Invocation) =>
	canonicalPath(path, invocation.canonicalCwd).pipe(
		Effect.map(Option.some),
		Effect.catchTag('ProjectPathResolutionError', (error) =>
			isNodeError(error.cause) && error.cause.code === 'ENOENT'
				? Effect.succeed(Option.none())
				: error,
		),
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
			const projectPath = yield* canonicalMatcherPath(
				project.project.matcher.path,
				invocation,
			);
			if (
				Option.isSome(projectPath) &&
				isPathMatch(projectPath.value, invocation.canonicalCwd)
			) {
				pathMatches.push({ project, pathLength: projectPath.value.length });
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
				? normalizeGitOrigin(project.project.matcher.origin) ===
					invocation.gitOrigin
				: false,
		);
		return {
			matchType: gitMatches.length > 0 ? ('git' as const) : ('none' as const),
			projects: gitMatches,
		};
	});
