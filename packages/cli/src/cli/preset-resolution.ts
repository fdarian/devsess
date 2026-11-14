import { Effect } from 'effect';
import { Prompt } from 'effect/cli';
import { CommandError, type CommandOptions } from './commands/daemon';
import type { ConfigPreset } from './config';
import { readConfig, resolveDefaultConfigPath } from './config';
import { cancelPicker } from './picker-cancellation';
import {
	captureInvocationWithGit,
	type Invocation,
	type MatchedProject,
	matchProjects,
	type ProjectMatches,
} from './project-matching';
import type { RunRecord } from './registry';
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

/** Most recently started first; presets that never ran keep their config order. */
export const byRecentUse = (
	candidates: ReadonlyArray<QualifiedPreset>,
	runs: ReadonlyArray<
		Pick<RunRecord, 'projectName' | 'presetName' | 'startedAt'>
	>,
) => {
	const lastStarted = new Map<QualifiedPreset, string>();
	for (const candidate of candidates)
		for (const run of runs) {
			if (
				run.projectName !== candidate.projectName ||
				run.presetName !== candidate.presetName
			)
				continue;
			const previous = lastStarted.get(candidate);
			if (previous === undefined || run.startedAt > previous)
				lastStarted.set(candidate, run.startedAt);
		}
	return candidates.slice().sort((left, right) => {
		const leftStarted = lastStarted.get(left);
		const rightStarted = lastStarted.get(right);
		if (leftStarted === rightStarted) return 0;
		if (leftStarted === undefined) return 1;
		if (rightStarted === undefined) return -1;
		return rightStarted.localeCompare(leftStarted);
	});
};

/** Qualifies a preset with its project only when another candidate shares its name. */
export const presetLabel = (
	candidate: QualifiedPreset,
	candidates: ReadonlyArray<QualifiedPreset>,
) =>
	candidates.some(
		(other) => other !== candidate && other.presetName === candidate.presetName,
	)
		? `${candidate.projectName}/${candidate.presetName}`
		: candidate.presetName;

export const choosePreset = <E, R>(
	candidates: ReadonlyArray<QualifiedPreset>,
	presetName: string | undefined,
	interactive: boolean,
	recentRuns: Effect.Effect<ReadonlyArray<RunRecord>, E, R>,
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
	return recentRuns.pipe(
		Effect.flatMap((runs) =>
			Prompt.run(
				Prompt.AutoComplete({
					message: 'Choose a preset',
					choices: byRecentUse(selection.candidates, runs).map((candidate) => ({
						title: presetLabel(candidate, selection.candidates),
						value: candidate,
					})),
				}),
			).pipe(
				Effect.catchTag('QuitError', cancelPicker),
				Effect.mapError(
					() => new CommandError({ message: 'Preset selection cancelled' }),
				),
			),
		),
	);
};

export const resolvePreset = <E, R>(
	options: PresetResolutionOptions,
	interactive: boolean,
	recentRuns: Effect.Effect<ReadonlyArray<RunRecord>, E, R>,
) =>
	Effect.gen(function* () {
		const parts = options.preset?.split('/');
		if (
			parts !== undefined &&
			(parts.length > 2 || parts.some((part) => part.length === 0))
		)
			return yield* new CommandError({
				message: `Invalid preset ${options.preset}. Use a preset or project/preset.`,
			});
		const project = parts?.length === 2 ? parts[0] : options.project;
		if (options.project !== undefined && project !== options.project)
			return yield* new CommandError({
				message: `--project ${options.project} conflicts with ${options.preset}.`,
			});
		const presetName = parts?.length === 2 ? parts[1] : options.preset;
		const resolved = yield* resolvePresetCandidates({ ...options, project });
		return {
			invocation: resolved.invocation,
			preset: yield* choosePreset(
				resolved.candidates,
				presetName,
				interactive,
				recentRuns,
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
					awaitPublish:
						preset.awaitPublish === true && service.awaitPublish !== false,
				},
			];
		});
