import { Effect } from 'effect';
import { Prompt } from 'effect/unstable/cli';
import { CommandError, type CommandOptions } from './commands/daemon';
import type { ConfigPreset } from './config';
import { readConfig, resolveDefaultConfigPath } from './config';
import {
	captureInvocationWithGit,
	type Invocation,
	type MatchedProject,
	matchProjects,
	type ProjectMatches,
} from './project-matching';
import {
	type QualifiedPreset,
	qualifiedPresets,
	resolveServiceCwd,
	selectPreset,
} from './selection';

export type PresetResolutionOptions = Pick<
	CommandOptions,
	'configPath' | 'project' | 'preset'
>;

export type ResolvedPresetCandidates = {
	readonly configPath: string;
	readonly invocation: Invocation;
	readonly matches: ProjectMatches;
	readonly projects: ReadonlyArray<MatchedProject>;
	readonly candidates: ReadonlyArray<QualifiedPreset>;
};

const configPathFor = (path: string | undefined) =>
	path === undefined ? resolveDefaultConfigPath : Effect.succeed(path);

export const resolvePresetCandidates = (
	options: Pick<PresetResolutionOptions, 'configPath' | 'project'>,
) =>
	Effect.gen(function* () {
		const configPath = yield* configPathFor(options.configPath);
		const config = yield* readConfig(configPath);
		const invocation = yield* captureInvocationWithGit(process.cwd());
		const matches = yield* matchProjects(config, invocation);
		const projects =
			options.project === undefined
				? matches.projects
				: matches.projects.filter(
						(project) => project.projectName === options.project,
					);
		if (projects.length === 0)
			return yield* new CommandError({
				message: 'No configured project matches this directory',
			});
		return {
			configPath,
			invocation,
			matches,
			projects,
			candidates: qualifiedPresets(projects),
		};
	});

export const choosePreset = (
	candidates: ReadonlyArray<QualifiedPreset>,
	presetName: string | undefined,
	interactive: boolean,
) => {
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

export const resolvePreset = (
	options: PresetResolutionOptions,
	interactive: boolean,
) =>
	Effect.gen(function* () {
		const resolved = yield* resolvePresetCandidates(options);
		return {
			invocation: resolved.invocation,
			preset: yield* choosePreset(
				resolved.candidates,
				options.preset,
				interactive,
			),
		};
	});

export const toServices = (preset: ConfigPreset, invocation: Invocation) =>
	Object.keys(preset.services)
		.sort((left, right) => left.localeCompare(right))
		.flatMap((name) => {
			const service = preset.services[name];
			if (service === undefined) return [];
			return [
				{
					name,
					command: service.command,
					cwd: resolveServiceCwd(service, invocation),
				},
			];
		});
