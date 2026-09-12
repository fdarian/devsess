import { Effect } from 'effect';
import type { RunRecord } from '../registry';
import {
	type CommandOptions,
	isRunActive,
	resolveCurrentRuns,
	write,
} from './daemon';

export const formatRunList = (resolved: {
	readonly current: ReadonlyArray<RunRecord>;
	readonly runs: ReadonlyArray<RunRecord>;
}) => {
	const current = resolved.current.filter(isRunActive);
	const elsewhere = resolved.runs.filter(
		(run) =>
			isRunActive(run) &&
			!current.some((candidate) => candidate.runId === run.runId),
	);
	const lines = [
		'Current project:',
		...current.map(
			(run) => `  ${run.projectName}/${run.presetName} ${run.state}`,
		),
	];
	if (elsewhere.length > 0) {
		lines.push(
			'Elsewhere:',
			...elsewhere.map(
				(run) => `  ${run.projectName}/${run.presetName} ${run.state}`,
			),
		);
	}
	return lines;
};

export const list = (options: CommandOptions) =>
	resolveCurrentRuns(options).pipe(
		Effect.flatMap((resolved) =>
			Effect.forEach(formatRunList(resolved), write, { discard: true }),
		),
	);
