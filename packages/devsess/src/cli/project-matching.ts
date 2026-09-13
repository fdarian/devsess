import { realpathSync } from 'node:fs';
import { isIP } from 'node:net';
import { homedir } from 'node:os';
import { isAbsolute, relative, resolve } from 'node:path';
import { Effect, Option, Schema, Stream } from 'effect';
import { ChildProcess } from 'effect/unstable/process';
import { ChildProcessSpawner } from 'effect/unstable/process/ChildProcessSpawner';
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
	repo?: string;
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
export const captureInvocation = (cwd: string, repo?: string) =>
	canonicalPath(cwd, process.cwd()).pipe(
		Effect.map(
			(canonicalCwd): Invocation => ({
				invocationCwd: cwd,
				canonicalCwd,
				repo: repo === undefined ? undefined : normalizeGitRepo(repo),
			}),
		),
	);

/** Reads the checkout's origin without contacting the remote. */
export const readGitOrigin = (cwd: string) =>
	Effect.scoped(
		Effect.gen(function* () {
			const spawner = yield* ChildProcessSpawner;
			const command = ChildProcess.make(
				'git',
				['remote', 'get-url', 'origin'],
				{ cwd, stdin: 'ignore', stdout: 'pipe', stderr: 'ignore' },
			);
			const handle = yield* spawner.spawn(command);
			const output = yield* Stream.mkString(
				handle.stdout.pipe(Stream.decodeText),
			);
			const exitCode = yield* handle.exitCode;
			if (exitCode !== 0) return Option.none<string>();
			const origin = output.trim();
			return origin.length === 0 ? Option.none<string>() : Option.some(origin);
		}),
	).pipe(
		Effect.catchTag('PlatformError', (error) =>
			error.reason._tag === 'NotFound'
				? Effect.succeed(Option.none<string>())
				: Effect.fail(error),
		),
	);

/** Captures the invocation path together with its local Git origin when available. */
export const captureInvocationWithGit = (cwd: string) =>
	Effect.gen(function* () {
		const repo = yield* readGitOrigin(cwd);
		return yield* captureInvocation(cwd, Option.getOrUndefined(repo));
	});

type NormalizedGitRepo = {
	host?: string;
	path: string;
};

const isHostname = (value: string) =>
	value === 'localhost' || value.includes('.') || isIP(value) !== 0;

const parseGitRepo = (repo: string): NormalizedGitRepo => {
	const trimmedRepo = repo
		.trim()
		.replace(/\/+$/, '')
		.replace(/\.git$/i, '');
	const urlRepo = trimmedRepo.match(
		/^(?:https?|ssh):\/\/(?:[^@/]+@)?([^/:]+)(?::\d+)?\/(.+)$/i,
	);
	if (urlRepo !== null) {
		const host = urlRepo[1];
		const path = urlRepo[2];
		if (host !== undefined && path !== undefined)
			return { host: host.toLowerCase(), path: path.toLowerCase() };
	}
	const scpRepo = trimmedRepo.match(/^(?:[^@/:]+@)?([^/:]+):(.+)$/);
	if (scpRepo !== null) {
		const host = scpRepo[1];
		const path = scpRepo[2];
		if (host !== undefined && path !== undefined)
			return { host: host.toLowerCase(), path: path.toLowerCase() };
	}
	const normalizedRepo = trimmedRepo.toLowerCase();
	const separator = normalizedRepo.indexOf('/');
	if (separator > 0) {
		const host = normalizedRepo.slice(0, separator);
		if (isHostname(host))
			return { host, path: normalizedRepo.slice(separator + 1) };
	}
	return { path: normalizedRepo };
};

/** Makes equivalent SSH and HTTPS remote spellings comparable. */
export const normalizeGitRepo = (repo: string) => {
	const normalized = parseGitRepo(repo);
	return normalized.host === undefined
		? normalized.path
		: `${normalized.host}/${normalized.path}`;
};

/**
 * A configured `repo` matches an invocation identity when they're equal, or
 * when the configured value is a shorthand landing on a `/` boundary — e.g.
 * `acme/project` matches `github.com/acme/project`, but `me/project` does not.
 */
export const matchesGitRepo = (
	invocationRepo: string,
	configuredRepo: string,
) => {
	const normalizedInvocationRepo = parseGitRepo(invocationRepo);
	const normalizedConfiguredRepo = parseGitRepo(configuredRepo);
	if (normalizedConfiguredRepo.host !== undefined)
		return (
			normalizedInvocationRepo.host === normalizedConfiguredRepo.host &&
			normalizedInvocationRepo.path === normalizedConfiguredRepo.path
		);
	return (
		normalizedInvocationRepo.path === normalizedConfiguredRepo.path ||
		normalizedInvocationRepo.path.endsWith(`/${normalizedConfiguredRepo.path}`)
	);
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
			project.project.matcher.type === 'git' && invocation.repo !== undefined
				? matchesGitRepo(invocation.repo, project.project.matcher.repo)
				: false,
		);
		return {
			matchType: gitMatches.length > 0 ? ('git' as const) : ('none' as const),
			projects: gitMatches,
		};
	});
