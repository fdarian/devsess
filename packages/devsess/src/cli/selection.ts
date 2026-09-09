import { isAbsolute, resolve } from 'node:path';
import type { ConfigPreset, ConfigService } from './config';
import type { Invocation, MatchedProject } from './project-matching';

export type QualifiedPreset = {
	projectName: string;
	presetName: string;
	preset: ConfigPreset;
};

export type PresetSelection =
	| { _tag: 'Selected'; preset: QualifiedPreset }
	| { _tag: 'NoMatchingPreset' }
	| { _tag: 'AmbiguousPreset'; candidates: ReadonlyArray<QualifiedPreset> };

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
		return invocation.canonicalCwd;
	}
	if (isAbsolute(service.cwd)) {
		return service.cwd;
	}
	return resolve(invocation.canonicalCwd, service.cwd);
};
