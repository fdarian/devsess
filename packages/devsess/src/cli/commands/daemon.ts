import { homedir } from 'node:os';
import { isAbsolute, join, relative } from 'node:path';
import { Config, Effect, Option, Runtime, Schema } from 'effect';
import { Command, Flag } from 'effect/unstable/cli';
import {
	ensureDaemon as ensureDaemonBootstrap,
	launchDetachedDaemon,
} from '../bootstrap';
import { callDaemon } from '../client';
import { DaemonLifecycle } from '../lifecycle';
import { captureInvocation } from '../project-matching';
import { isActive, type RunRecord, RunRecordSchema } from '../registry';

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
	force?: boolean;
};

export type DaemonLocation = { dataDirectory: string; socketPath: string };

export const isRunActive = (run: RunRecord) =>
	run.services.some(
		(service) => isActive(service.state) || service.state === 'orphaned',
	);
const isRunTailable = (run: RunRecord) =>
	isRunActive(run) || run.state === 'exited' || run.state === 'failed';

const containsPath = (parent: string, child: string) => {
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

export const resolveCurrentRuns = (
	options: CommandOptions,
	includeCompleted = false,
) =>
	Effect.gen(function* () {
		const invocation = yield* captureInvocation(process.cwd());
		const location = yield* resolveDaemonLocation;
		yield* ensureDaemon(location);
		const runs = yield* callDaemon(location.socketPath, {
			version: 1,
			requestId: requestId(),
			method: 'listRuns',
			params: {},
		}).pipe(Effect.flatMap(decodeRunListResponse));
		const current = runs.filter(
			(run) =>
				containsPath(run.canonicalCwd, invocation.canonicalCwd) &&
				(includeCompleted ? isRunTailable(run) : isRunActive(run)) &&
				(options.project === undefined || run.projectName === options.project),
		);
		return { location, runs, current };
	});

export const chooseRun = (
	runs: ReadonlyArray<RunRecord>,
	options: CommandOptions,
): Effect.Effect<RunRecord, CommandError> => {
	const named =
		options.preset === undefined
			? runs
			: runs.filter((run) => run.presetName === options.preset);
	const run = named[0];
	if (named.length === 1 && run !== undefined) return Effect.succeed(run);
	if (named.length === 0)
		return Effect.fail(
			new CommandError({ message: 'No running preset matches this command' }),
		);
	return Effect.fail(
		new CommandError({
			message: `Multiple running presets match: ${named.map((run) => `${run.projectName}/${run.presetName}`).join(', ')}. Specify a preset.`,
		}),
	);
};

export const daemonCommand = Command.make(
	'__daemon',
	{
		dataDirectory: Flag.string('data-directory'),
		socketPath: Flag.string('socket-path'),
	},
	(input) =>
		Effect.never.pipe(
			Effect.provide(
				DaemonLifecycle.layer({
					dataDirectory: input.dataDirectory,
					socketPath: input.socketPath,
				}),
			),
		),
).pipe(Command.withHidden);
