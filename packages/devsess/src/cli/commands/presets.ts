import { Effect, Option } from 'effect';
import { callDaemon } from '../client';
import {
	type PresetResolutionOptions,
	type ResolvedPresetCandidates,
	resolvePresetCandidates,
	toServices,
} from '../preset-resolution';
import { PROTOCOL_VERSION } from '../protocol';
import type { RunRecord } from '../registry';
import {
	decodeRunListResponse,
	isRunActive,
	requestId,
	resolveDaemonLocation,
	write,
} from './daemon';

const reachableRuns = (socketPath: string) =>
	callDaemon(socketPath, {
		version: PROTOCOL_VERSION,
		requestId: requestId(),
		method: 'listRuns',
		params: {},
	}).pipe(
		Effect.flatMap(decodeRunListResponse),
		Effect.map(Option.some),
		Effect.catch(() => Effect.succeed(Option.none<ReadonlyArray<RunRecord>>())),
	);

const isRunning = (
	runs: ReadonlyArray<RunRecord>,
	projectName: string,
	presetName: string,
) =>
	runs.some(
		(run) =>
			isRunActive(run) &&
			run.projectName === projectName &&
			run.presetName === presetName,
	);

export const formatPresetList = (
	resolved: ResolvedPresetCandidates,
	runs: Option.Option<ReadonlyArray<RunRecord>>,
	interactive: boolean,
) => {
	const lines = [`Config file: ${resolved.configPath}`, 'Matched projects:'];
	const matchLabel =
		resolved.matches.matchType === 'git'
			? 'git origin'
			: resolved.matches.matchType;
	for (const project of resolved.projects)
		lines.push(`  ${project.projectName} (matched by ${matchLabel})`);
	if (resolved.candidates.length === 0) {
		lines.push('Presets: none');
		lines.push('Bare start: would fail because no matching preset exists.');
		return lines;
	}
	lines.push('Presets:');
	for (const candidate of resolved.candidates) {
		const running =
			Option.isSome(runs) &&
			isRunning(runs.value, candidate.projectName, candidate.presetName);
		lines.push(
			`  ${candidate.projectName}/${candidate.presetName}${running ? ' [running]' : ''}`,
		);
		for (const service of toServices(candidate.preset, resolved.invocation))
			lines.push(
				`    ${service.name}: ${service.command} (cwd: ${service.cwd})`,
			);
	}
	if (resolved.candidates.length === 1) {
		const candidate = resolved.candidates[0];
		if (candidate === undefined) return lines;
		lines.push(
			`Bare start: auto-selects ${candidate.projectName}/${candidate.presetName}.`,
		);
	} else if (interactive) {
		lines.push(
			`Bare start: interactive picker for ${resolved.candidates.length} candidates; non-interactive invocation would fail.`,
		);
	} else {
		lines.push(
			'Bare start: would fail non-interactively; an interactive TTY would show a picker.',
		);
	}
	return lines;
};

export const presets = (
	options: Pick<PresetResolutionOptions, 'configPath' | 'project'>,
) =>
	Effect.gen(function* () {
		const resolved = yield* resolvePresetCandidates(options);
		const location = yield* resolveDaemonLocation;
		const runs = yield* reachableRuns(location.socketPath);
		const lines = formatPresetList(
			resolved,
			runs,
			process.stdin.isTTY === true,
		);
		yield* Effect.forEach(lines, write, { discard: true });
	});
