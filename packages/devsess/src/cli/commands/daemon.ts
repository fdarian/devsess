import { homedir } from 'node:os';
import { isAbsolute, join, relative } from 'node:path';
import { Config, Effect, Option, Runtime, Schema } from 'effect';
import type { FileSystem } from 'effect/FileSystem';
import type { Path } from 'effect/Path';
import type { Terminal } from 'effect/Terminal';
import { Command, Flag, Prompt } from 'effect/unstable/cli';
import {
	ensureDaemon as ensureDaemonBootstrap,
	launchDetachedDaemon,
} from '../bootstrap';
import { callDaemon } from '../client';
import { DaemonLifecycle } from '../lifecycle';
import { captureInvocation } from '../project-matching';
import { isRunActive, type RunRecord, RunRecordSchema } from '../registry';

export class CommandError extends Schema.TaggedErrorClass<CommandError>()(
	'devsess/cli/CommandError',
	{ message: Schema.String, cause: Schema.optional(Schema.Defect()) },
) {
	override readonly [Runtime.errorExitCode] = 1;
}

export type CommandOptions = {
	configPath?: string;
	project?: string;
	service?: string;
	preset?: string;
	runId?: string;
	allServices?: boolean;
	force?: boolean;
};

export type DaemonLocation = { dataDirectory: string; socketPath: string };

export { isRunActive } from '../registry';

export const containsPath = (parent: string, child: string) => {
	const path = relative(parent, child);
	return (
		path === '' ||
		(!path.startsWith('../') && path !== '..' && !isAbsolute(path))
	);
};

export const write = (line: string) =>
	Effect.sync(() => process.stdout.write(`${line}\n`));

export const daemonLocation = (
	stateHome: string,
	runtimeDirectory: string,
): DaemonLocation => {
	const dataDirectory = join(stateHome, 'devsess');
	return { dataDirectory, socketPath: join(runtimeDirectory, 'devsess.sock') };
};

/** Resolves the one daemon location shared by every project for this user. */
export const resolveDaemonLocation = Effect.gen(function* () {
	const xdgStateHome = yield* Config.string('XDG_STATE_HOME').pipe(
		Config.option,
	);
	const xdgRuntimeDirectory = yield* Config.string('XDG_RUNTIME_DIR').pipe(
		Config.option,
	);
	const stateHome = Option.match(xdgStateHome, {
		onNone: () => join(homedir(), '.local', 'state'),
		onSome: (path) => path,
	});
	const runtimeDirectory = Option.match(xdgRuntimeDirectory, {
		onNone: () => join('/tmp', `devsess-${process.getuid?.() ?? process.pid}`),
		onSome: (path) => join(path, 'devsess'),
	});
	return daemonLocation(stateHome, runtimeDirectory);
});

export const requestId = () => crypto.randomUUID();

export const decodeRunResponse = (value: unknown) =>
	Schema.decodeUnknownEffect(RunRecordSchema)(value).pipe(
		Effect.mapError(
			(cause) =>
				new CommandError({
					message: 'Daemon returned an invalid run response',
					cause,
				}),
		),
	);

export const decodeRunListResponse = (value: unknown) =>
	Schema.decodeUnknownEffect(Schema.Array(RunRecordSchema))(value).pipe(
		Effect.mapError(
			(cause) =>
				new CommandError({
					message: 'Daemon returned an invalid run list response',
					cause,
				}),
		),
	);

/** Starts the detached daemon only when its socket cannot complete a handshake. */
export const ensureDaemon = (location: DaemonLocation) =>
	ensureDaemonBootstrap({
		location,
		launch: () =>
			launchDetachedDaemon({
				command: process.execPath,
				args: [
					process.argv[1] ?? 'devsess',
					'__daemon',
					'--data-directory',
					location.dataDirectory,
					'--socket-path',
					location.socketPath,
				],
			}),
	});

export const resolveCurrentRuns = () =>
	Effect.gen(function* () {
		const invocation = yield* captureInvocation(process.cwd());
		const location = yield* resolveDaemonLocation;
		const runs = yield* callDaemon(location.socketPath, {
			version: 1,
			requestId: requestId(),
			method: 'listRuns',
			params: {},
		}).pipe(
			Effect.flatMap(decodeRunListResponse),
			Effect.mapError(
				(cause) =>
					new CommandError({
						message:
							'Cannot read running sessions. Is the daemon running? See `devsess status`.',
						cause,
					}),
			),
		);
		const current = runs.filter(isRunActive);
		const localRuns = runs.filter((run) =>
			containsPath(run.canonicalCwd, invocation.canonicalCwd),
		);
		const local = localRuns.filter(isRunActive);
		return { location, runs, current, local, localRuns };
	});

const runChoices = (runs: ReadonlyArray<RunRecord>) =>
	runs.map((run) => {
		const name = `${run.projectName}/${run.presetName}`;
		const duplicated = runs.some(
			(other) =>
				other.runId !== run.runId &&
				other.projectName === run.projectName &&
				other.presetName === run.presetName,
		);
		const shortId = runs.some(
			(other) =>
				other.runId !== run.runId &&
				other.runId.startsWith(run.runId.slice(0, 8)),
		)
			? run.runId
			: run.runId.slice(0, 8);
		return {
			run,
			label: duplicated
				? `${name} [${shortId}] started ${run.startedAt}`
				: name,
			selector: duplicated ? ` --run ${run.runId}` : '',
		};
	});

export const chooseRun = (
	runs: ReadonlyArray<RunRecord>,
	options: CommandOptions,
	command = 'tail',
	interactive = process.stdin.isTTY === true && process.stdout.isTTY === true,
	local: ReadonlyArray<RunRecord> = runs,
	finished: ReadonlyArray<RunRecord> = [],
): Effect.Effect<RunRecord, CommandError, FileSystem | Path | Terminal> => {
	const active = runs.filter(isRunActive);
	const parts = options.preset?.split('/');
	if (
		parts !== undefined &&
		(parts.length > 2 || parts.some((part) => part.length === 0))
	)
		return new CommandError({
			message: `Invalid preset ${options.preset}. Use a preset or project/preset.`,
		});
	const positionalProject = parts?.length === 2 ? parts[0] : undefined;
	if (
		positionalProject !== undefined &&
		options.project !== undefined &&
		positionalProject !== options.project
	)
		return new CommandError({
			message: `--project ${options.project} conflicts with ${options.preset}.`,
		});
	const presetName = parts?.length === 2 ? parts[1] : options.preset;
	const projectName =
		positionalProject === undefined ? options.project : positionalProject;
	const matches = active.filter(
		(run) =>
			(projectName === undefined || run.projectName === projectName) &&
			(presetName === undefined || run.presetName === presetName) &&
			(options.runId === undefined || run.runId.startsWith(options.runId)),
	);
	// Runs started under the current directory win only when the user did not name a project or run.
	const localMatches = matches.filter((run) =>
		local.some((other) => other.runId === run.runId),
	);
	const candidates =
		projectName === undefined &&
		options.runId === undefined &&
		localMatches.length > 0
			? localMatches
			: matches;
	if (candidates.length === 0 && finished.length > 0) {
		const matching = finished.filter(
			(run) =>
				!isRunActive(run) &&
				(projectName === undefined || run.projectName === projectName) &&
				(presetName === undefined || run.presetName === presetName) &&
				(options.runId === undefined || run.runId.startsWith(options.runId)),
		);
		const nearby = matching.filter((run) =>
			local.some((candidate) => candidate.runId === run.runId),
		);
		const recent =
			projectName === undefined &&
			options.runId === undefined &&
			nearby.length > 0
				? nearby
				: matching;
		const latest = recent
			.slice()
			.sort((left, right) => right.startedAt.localeCompare(left.startedAt))[0];
		if (latest !== undefined) return Effect.succeed(latest);
	}
	const run = candidates[0];
	if (candidates.length === 1 && run !== undefined) return Effect.succeed(run);
	const choices = runChoices(candidates);
	if (candidates.length === 0)
		return new CommandError({
			message: `Nothing running matches ${options.preset === undefined ? 'this command' : options.preset}. Running: ${
				runChoices(active)
					.map((choice) => choice.label)
					.join(', ') || 'none'
			}. See \`devsess status\`.`,
		});
	if (interactive)
		return Prompt.run(
			Prompt.select({
				message: 'Choose a running preset',
				choices: choices.map((choice) => ({
					title: choice.label,
					value: choice.run,
				})),
			}),
		).pipe(
			Effect.mapError(
				() => new CommandError({ message: 'Preset selection cancelled' }),
			),
		);
	return new CommandError({
		message: `Multiple running presets match:\n${choices.map((choice) => `  ${choice.label} — devsess ${command} ${choice.run.projectName}/${choice.run.presetName}${choice.selector}`).join('\n')}\nSee \`devsess status\`.`,
	});
};

export const daemonCommand = Command.make(
	'__daemon',
	{
		dataDirectory: Flag.string('data-directory'),
		socketPath: Flag.string('socket-path'),
	},
	(input) =>
		Effect.gen(function* () {
			const lifecycle = yield* DaemonLifecycle;
			yield* lifecycle.daemon.awaitShutdown;
		}).pipe(
			Effect.provide(
				DaemonLifecycle.layer({
					dataDirectory: input.dataDirectory,
					socketPath: input.socketPath,
				}),
			),
		),
).pipe(Command.withHidden);
