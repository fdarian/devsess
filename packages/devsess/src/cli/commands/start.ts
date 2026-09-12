import { join } from 'node:path';
import { Effect } from 'effect';
import { Prompt } from 'effect/unstable/cli';
import { callDaemon } from '../client';
import type { ConfigPreset } from '../config';
import { readConfig, resolveDefaultConfigPath } from '../config';
import {
	captureInvocation,
	type Invocation,
	type MatchedProject,
	matchProjects,
} from '../project-matching';
import type { DaemonRequest } from '../protocol';
import { qualifiedPresets, selectPreset } from '../selection';
import type { CommandOptions } from './daemon';
import {
	CommandError,
	decodeRunResponse,
	ensureDaemon,
	requestId,
	resolveDaemonLocation,
	write,
} from './daemon';

const configPathFor = (path: string | undefined) =>
	path === undefined ? resolveDefaultConfigPath : Effect.succeed(path);

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
		Object.entries(process.env).flatMap((entry) => {
			const key = entry[0];
			const value = entry[1];
			return value === undefined || key === undefined ? [] : [[key, value]];
		}),
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
		const run = yield* callDaemon(location.socketPath, request).pipe(
			Effect.flatMap(decodeRunResponse),
		);
		return yield* write(
			`Started ${resolved.preset.projectName}/${resolved.preset.presetName}: ${run.runId}`,
		);
	});
