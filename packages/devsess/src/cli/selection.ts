import { isAbsolute, resolve } from 'node:path';
import type { ConfigPreset, ConfigService } from './config';
import type { Invocation, MatchedProject } from './project-matching';

export type QualifiedPreset = {
	projectName: string;
	presetName: string;
	preset: ConfigPreset;
};

export type ProjectSelection =
	| { _tag: 'SelectedProject'; project: MatchedProject }
	| { _tag: 'NoMatchingProject' }
	| { _tag: 'AmbiguousProject'; candidates: ReadonlyArray<MatchedProject> };

export type PresetSelection =
	| { _tag: 'Selected'; preset: QualifiedPreset }
	| { _tag: 'NoMatchingPreset' }
	| { _tag: 'AmbiguousPreset'; candidates: ReadonlyArray<QualifiedPreset> };

/** Produces stable, qualified project choices for reporting and selection. */
export const qualifiedProjects = (
	projects: ReadonlyArray<MatchedProject>,
): ReadonlyArray<MatchedProject> =>
	projects
		.slice()
		.sort((left, right) => left.projectName.localeCompare(right.projectName));

/** Leaves project ambiguity visible unless a matching --project was supplied. */
export const selectProject = (
	candidates: ReadonlyArray<MatchedProject>,
	requestedProjectName?: string,
): ProjectSelection => {
	const qualifiedCandidates = qualifiedProjects(candidates);
	const applicableCandidates =
		requestedProjectName === undefined
			? qualifiedCandidates
			: qualifiedCandidates.filter(
					(candidate) => candidate.projectName === requestedProjectName,
				);
	if (applicableCandidates.length === 0) {
		return { _tag: 'NoMatchingProject' };
	}
	if (applicableCandidates.length > 1) {
		return { _tag: 'AmbiguousProject', candidates: applicableCandidates };
	}
	const project = applicableCandidates[0];
	return project === undefined
		? { _tag: 'NoMatchingProject' }
		: { _tag: 'SelectedProject', project };
};

/** Produces a stable, fully qualified picker/reporting list. */
export const qualifiedPresets = (
	projects: ReadonlyArray<MatchedProject>,
): ReadonlyArray<QualifiedPreset> =>
	projects.flatMap((project) =>
		Object.keys(project.project.presets)
			.sort((left, right) => left.localeCompare(right))
			.flatMap((presetName): Array<QualifiedPreset> => {
				const preset = project.project.presets[presetName];
				return preset === undefined
					? []
					: [{ projectName: project.projectName, presetName, preset }];
			}),
	);

/** Leaves multiple possible presets visible to the command layer. */
export const selectPreset = (
	candidates: ReadonlyArray<QualifiedPreset>,
	requestedPresetName?: string,
): PresetSelection => {
	const applicableCandidates =
		requestedPresetName === undefined
			? candidates
			: candidates.filter(
					(candidate) => candidate.presetName === requestedPresetName,
				);
	if (applicableCandidates.length === 0) {
		return { _tag: 'NoMatchingPreset' };
	}
	if (applicableCandidates.length > 1) {
		return { _tag: 'AmbiguousPreset', candidates: applicableCandidates };
	}
	const preset = applicableCandidates[0];
	return preset === undefined
		? { _tag: 'NoMatchingPreset' }
		: { _tag: 'Selected', preset };
};

/** Applies the start-time cwd rule without consulting the daemon's cwd. */
export const resolveServiceCwd = (
	service: ConfigService,
	invocation: Invocation,
) => {
	if (service.cwd === undefined) {
		return invocation.invocationCwd;
	}
	if (isAbsolute(service.cwd)) {
		return service.cwd;
	}
	return resolve(invocation.invocationCwd, service.cwd);
};
