import { existsSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join, relative } from 'node:path';
import { Config, Effect, Option, Queue, Schema } from 'effect';
import { Prompt } from 'effect/unstable/cli';
import { awaitDaemonHandshake, launchDetachedDaemon } from './bootstrap';
import { callDaemon } from './client';
import type { ConfigPreset } from './config';
import { readConfig, resolveDefaultConfigPath } from './config';
import {
	captureInvocation,
	type Invocation,
	type MatchedProject,
	matchProjects,
} from './project-matching';
import type { DaemonRequest } from './protocol';
import type { RunRecord } from './registry';
import { qualifiedPresets, selectPreset } from './selection';
import { openDaemonStream } from './terminal';

export class CommandError extends Schema.TaggedErrorClass<CommandError>()(
	'devsess/cli/CommandError',
	{ message: Schema.String, cause: Schema.optional(Schema.Defect()) },
) {}

export type CommandOptions = {
	configPath?: string;
	project?: string;
	service?: string;
	preset?: string;
};

export type DaemonLocation = { dataDirectory: string; socketPath: string };

const active = (run: RunRecord) =>
	run.services.some(
		(service) =>
			service.state === 'starting' ||
			service.state === 'running' ||
			service.state === 'stopping' ||
			service.state === 'orphaned',
	);

const containsPath = (parent: string, child: string) => {
	const path = relative(parent, child);
	return (
		path === '' ||
		(!path.startsWith('../') && path !== '..' && !isAbsolute(path))
	);
};

const write = (line: string) =>
	Effect.sync(() => process.stdout.write(`${line}\n`));
const configPathFor = (path: string | undefined) =>
	path === undefined ? resolveDefaultConfigPath : Effect.succeed(path);

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

const requestId = () => crypto.randomUUID();
const toServices = (preset: ConfigPreset, invocation: Invocation) =>
	Object.keys(preset.services)
		.sort((left, right) => left.localeCompare(right))
		.flatMap((name) => {
			const service = preset.services[name];
			if (service === undefined) return [];
			const cwd =
				service.cwd === undefined
					? invocation.invocationCwd
					: service.cwd.startsWith('/')
						? service.cwd
						: join(invocation.invocationCwd, service.cwd);
			return [{ name, command: service.command, cwd }];
		});

const clientEnvironment = () =>
	Object.fromEntries(
		Object.entries(process.env).flatMap(([key, value]) =>
			value === undefined ? [] : [[key, value]],
		),
	);

const choosePreset = (
	projects: ReadonlyArray<MatchedProject>,
	presetName: string | undefined,
	interactive: boolean,
) => {
	const candidates = qualifiedPresets(projects);
	const selection = selectPreset(candidates, presetName);
	if (selection._tag === 'Selected') return Effect.succeed(selection.preset);
	if (selection._tag === 'NoMatchingPreset')
		return Effect.fail(
			new CommandError({ message: 'No matching preset was found' }),
		);
	if (!interactive)
		return Effect.fail(
			new CommandError({
				message: `Preset is ambiguous: ${selection.candidates.map((candidate) => `${candidate.projectName}/${candidate.presetName}`).join(', ')}. Specify --project or a preset.`,
			}),
		);
	return Prompt.run(
		Prompt.select({
			message: 'Choose a preset',
			choices: selection.candidates.map((candidate) => ({
				title: `${candidate.projectName}/${candidate.presetName}`,
				value: candidate,
			})),
		}),
	).pipe(
		Effect.mapError(
			() => new CommandError({ message: 'Preset selection cancelled' }),
		),
	);
};

const resolvePreset = (options: CommandOptions, interactive: boolean) =>
	Effect.gen(function* () {
		const configPath = yield* configPathFor(options.configPath);
		const config = yield* readConfig(configPath);
		const invocation = yield* captureInvocation(process.cwd());
		const matches = yield* matchProjects(config, invocation);
		const projects =
			options.project === undefined
				? matches.projects
				: matches.projects.filter(
						(project) => project.projectName === options.project,
					);
		if (projects.length === 0)
			return yield* Effect.fail(
				new CommandError({
					message: 'No configured project matches this directory',
				}),
			);
		return {
			invocation,
			preset: yield* choosePreset(projects, options.preset, interactive),
			config,
		};
	});

/** Starts a selected preset after capturing the client environment at this boundary. */
export const start = (options: CommandOptions, interactive: boolean) =>
	Effect.gen(function* () {
		const resolved = yield* resolvePreset(options, interactive);
		const location = yield* resolveDaemonLocation;
		yield* ensureDaemon(location);
		const request: DaemonRequest = {
			version: 1,
			requestId: requestId(),
			method: 'startRun',
			params: {
				runId: requestId(),
				projectName: resolved.preset.projectName,
				presetName: resolved.preset.presetName,
				canonicalCwd: resolved.invocation.canonicalCwd,
				invocationCwd: resolved.invocation.invocationCwd,
				configSnapshot: {
					projectName: resolved.preset.projectName,
					presetName: resolved.preset.presetName,
					preset: resolved.preset.preset,
				},
				environment: clientEnvironment(),
				services: toServices(resolved.preset.preset, resolved.invocation),
			},
		};
		const run = yield* callDaemon(location.socketPath, request);
		return yield* write(
			`Started ${resolved.preset.projectName}/${resolved.preset.presetName}: ${(run as RunRecord).runId}`,
		);
	});

/** Starts the detached daemon only when its socket cannot complete a handshake. */
export const ensureDaemon = (location: DaemonLocation) =>
	awaitDaemonHandshake({
		socketPath: location.socketPath,
		timeoutMs: 150,
	}).pipe(
		Effect.catch(() =>
			Effect.gen(function* () {
				if (!existsSync(location.dataDirectory)) {
					yield* Effect.try({
						try: () => {
							mkdirSync(location.dataDirectory, {
								recursive: true,
								mode: 0o700,
							});
							mkdirSync(join(location.socketPath, '..'), {
								recursive: true,
								mode: 0o700,
							});
						},
						catch: (cause) =>
							new CommandError({
								message: `Could not create ${location.dataDirectory}`,
								cause,
							}),
					});
				}
				yield* launchDetachedDaemon({
					command: process.execPath,
					args: [
						process.argv[1] ?? 'devsess',
						'__daemon',
						'--data-directory',
						location.dataDirectory,
						'--socket-path',
						location.socketPath,
					],
				});
				return yield* awaitDaemonHandshake({
					socketPath: location.socketPath,
					timeoutMs: 5_000,
				});
			}),
		),
	);

const resolveCurrentRuns = (options: CommandOptions) =>
	Effect.gen(function* () {
		const invocation = yield* captureInvocation(process.cwd());
		const location = yield* resolveDaemonLocation;
		yield* ensureDaemon(location);
		const runs = (yield* callDaemon(location.socketPath, {
			version: 1,
			requestId: requestId(),
			method: 'listRuns',
			params: {},
		})) as ReadonlyArray<RunRecord>;
		const current = runs.filter(
			(run) =>
				containsPath(run.canonicalCwd, invocation.canonicalCwd) &&
				active(run) &&
				(options.project === undefined || run.projectName === options.project),
		);
		return { location, runs, current };
	});

const chooseRun = (
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

export const list = (options: CommandOptions) =>
	resolveCurrentRuns(options).pipe(
		Effect.flatMap(({ current, runs }) =>
			Effect.forEach(
				[
					'Current project:',
					...current.map(
						(run) => `  ${run.projectName}/${run.presetName} ${run.state}`,
					),
					'Elsewhere:',
					...runs
						.filter((run) => !current.includes(run))
						.map(
							(run) => `  ${run.projectName}/${run.presetName} ${run.state}`,
						),
				],
				write,
				{ discard: true },
			),
		),
	);

export const stop = (options: CommandOptions) =>
	resolveCurrentRuns(options).pipe(
		Effect.flatMap(({ location, current }) =>
			chooseRun(current, options).pipe(
				Effect.flatMap((run) =>
					callDaemon(location.socketPath, {
						version: 1,
						requestId: requestId(),
						method: 'stopRun',
						params: { runId: run.runId },
					}).pipe(
						Effect.andThen(
							write(`Stopped ${run.projectName}/${run.presetName}`),
						),
					),
				),
			),
		),
	);

const chooseService = (
	run: RunRecord,
	serviceName: string | undefined,
): Effect.Effect<RunRecord['services'][number], CommandError> => {
	const candidates =
		serviceName === undefined
			? run.services
			: run.services.filter((service) => service.name === serviceName);
	const service = candidates[0];
	if (candidates.length === 1 && service !== undefined)
		return Effect.succeed(service);
	if (candidates.length === 0)
		return Effect.fail(
			new CommandError({ message: 'No matching service is running' }),
		);
	return Effect.fail(
		new CommandError({
			message: `Preset ${run.projectName}/${run.presetName} has multiple services. Specify --service: ${candidates.map((candidate) => candidate.name).join(', ')}.`,
		}),
	);
};

const tailService = (
	location: DaemonLocation,
	run: RunRecord,
	service: RunRecord['services'][number],
	prefix: boolean,
) =>
	openDaemonStream({
		socketPath: location.socketPath,
		request: {
			version: 1,
			requestId: requestId(),
			method: 'tail',
			params: { runId: run.runId, serviceName: service.name },
		},
	}).pipe(
		Effect.flatMap((stream) =>
			Effect.forever(
				Queue.take(stream.frames).pipe(
					Effect.flatMap((frame) => {
						if (frame._tag === 'output')
							return Effect.sync(() =>
								process.stdout.write(
									prefix
										? `[${service.name}] ${frame.value.data}`
										: frame.value.data,
								),
							);
						if (frame._tag === 'closed')
							return Effect.fail(
								new CommandError({ message: 'Daemon output stream closed' }),
							);
						return frame.value.ok
							? Effect.void
							: Effect.fail(
									new CommandError({
										message:
											frame.value.error ?? 'Daemon rejected tail request',
									}),
								);
					}),
				),
			),
		),
	);

/** Streams all matching services, qualifying output when more than one is selected. */
export const tail = (options: CommandOptions) =>
	Effect.scoped(
		resolveCurrentRuns(options).pipe(
			Effect.flatMap((resolved) =>
				chooseRun(resolved.current, options).pipe(
					Effect.flatMap((run) => {
						const services =
							options.service === undefined
								? run.services
								: run.services.filter(
										(service) => service.name === options.service,
									);
						if (services.length === 0)
							return Effect.fail(
								new CommandError({ message: 'No matching service is running' }),
							);
						return Effect.all(
							services.map((service) =>
								tailService(
									resolved.location,
									run,
									service,
									services.length > 1,
								),
							),
							{ concurrency: 'unbounded', discard: true },
						);
					}),
				),
			),
		),
	);

/** Attaches one input lease; Ctrl-] returns to the caller and Ctrl-C reaches the service. */
export const attach = (options: CommandOptions) =>
	Effect.scoped(
		resolveCurrentRuns(options).pipe(
			Effect.flatMap(({ location, current }) =>
				chooseRun(current, options).pipe(
					Effect.flatMap((run) =>
						chooseService(run, options.service).pipe(
							Effect.flatMap((service) =>
								openDaemonStream({
									socketPath: location.socketPath,
									request: {
										version: 1,
										requestId: requestId(),
										method: 'attach',
										params: { runId: run.runId, serviceName: service.name },
									},
								}).pipe(
									Effect.flatMap((stream) =>
										Queue.take(stream.frames).pipe(
											Effect.flatMap((frame) => {
												if (frame._tag !== 'response' || !frame.value.ok)
													return Effect.fail(
														new CommandError({
															message: 'Daemon rejected attach request',
														}),
													);
												const result = frame.value.result;
												if (
													typeof result !== 'object' ||
													result === null ||
													!('leaseId' in result) ||
													typeof result.leaseId !== 'string'
												)
													return Effect.fail(
														new CommandError({
															message:
																'Daemon returned an invalid attach lease',
														}),
													);
												const send = (
													method: 'input' | 'resize' | 'detach',
													params: Record<string, unknown>,
												) =>
													callDaemon(location.socketPath, {
														version: 1,
														requestId: requestId(),
														method,
														params: {
															runId: run.runId,
															serviceName: service.name,
															leaseId: result.leaseId,
															...params,
														} as never,
													});
												const onResize = () =>
													Effect.runFork(
														send('resize', {
															cols: process.stdout.columns,
															rows: process.stdout.rows,
														}),
													);
												const detached = Effect.promise(
													() =>
														new Promise<void>((resolve) => {
															const onInput = (data: Buffer) => {
																if (data.equals(Buffer.from('\u001d'))) {
																	Effect.runFork(send('detach', {}));
																	resolve();
																	return;
																}
																Effect.runFork(
																	send('input', { data: data.toString() }),
																);
															};
															process.stdin.on('data', onInput);
														}),
												);
												return Effect.acquireRelease(
													Effect.sync(() => {
														process.stdin.setRawMode(true);
														process.stdin.resume();
														process.stdout.on('resize', onResize);
													}),
													() =>
														Effect.sync(() => {
															process.stdout.off('resize', onResize);
															process.stdin.setRawMode(false);
														}),
												).pipe(Effect.andThen(detached));
											}),
										),
									),
								),
							),
						),
					),
				),
			),
		),
	);
