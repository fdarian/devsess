import { createHash } from 'node:crypto';
import { existsSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Effect, Queue, Schema } from 'effect';
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
			service.state === 'stopping',
	);

const write = (line: string) =>
	Effect.sync(() => process.stdout.write(`${line}\n`));
const configPathFor = (path: string | undefined) =>
	path === undefined ? resolveDefaultConfigPath : Effect.succeed(path);

export const daemonLocation = (canonicalCwd: string): DaemonLocation => {
	const id = createHash('sha256')
		.update(canonicalCwd)
		.digest('hex')
		.slice(0, 16);
	const dataDirectory = join(tmpdir(), 'devsess', id);
	return { dataDirectory, socketPath: join(dataDirectory, 'daemon.sock') };
};

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
		const location = daemonLocation(resolved.invocation.canonicalCwd);
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
						try: () => mkdirSync(location.dataDirectory, { recursive: true }),
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
		const location = daemonLocation(invocation.canonicalCwd);
		yield* ensureDaemon(location);
		const runs = (yield* callDaemon(location.socketPath, {
			version: 1,
			requestId: requestId(),
			method: 'listRuns',
			params: {},
		})) as ReadonlyArray<RunRecord>;
		const current = runs.filter(
			(run) =>
				run.canonicalCwd === invocation.canonicalCwd &&
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

export const list = () =>
	resolveCurrentRuns({}).pipe(
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

/** Streams persisted and live output until the terminal closes the connection. */
export const tail = (options: CommandOptions) =>
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
															process.stdout.write(frame.value.data),
														);
													if (frame._tag === 'closed')
														return Effect.fail(
															new CommandError({
																message: 'Daemon output stream closed',
															}),
														);
													if (!frame.value.ok)
														return Effect.fail(
															new CommandError({
																message:
																	frame.value.error ??
																	'Daemon rejected tail request',
															}),
														);
													return Effect.void;
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
												const onData = (data: Buffer) => {
													if (data.equals(Buffer.from('\u001d')))
														Effect.runFork(send('detach', {}));
													else
														Effect.runFork(
															send('input', { data: data.toString() }),
														);
												};
												const onResize = () =>
													Effect.runFork(
														send('resize', {
															cols: process.stdout.columns,
															rows: process.stdout.rows,
														}),
													);
												return Effect.acquireRelease(
													Effect.sync(() => {
														process.stdin.setRawMode(true);
														process.stdin.resume();
														process.stdin.on('data', onData);
														process.stdout.on('resize', onResize);
													}),
													() =>
														Effect.sync(() => {
															process.stdin.off('data', onData);
															process.stdout.off('resize', onResize);
															process.stdin.setRawMode(false);
														}),
												).pipe(Effect.andThen(Effect.never));
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
