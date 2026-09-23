import type { RunRecord } from './registry';

export const shortRunId = (run: RunRecord, runs: ReadonlyArray<RunRecord>) => {
	const otherIds = runs.filter((candidate) => candidate.runId !== run.runId);
	for (
		let length = Math.min(8, run.runId.length);
		length < run.runId.length;
		length += 1
	) {
		const prefix = run.runId.slice(0, length);
		if (
			otherIds.every((candidate) => !candidate.runId.startsWith(prefix)) &&
			runs.every((candidate) => candidate.presetName !== prefix)
		)
			return prefix;
	}
	return run.runId;
};

export const runSelector = (run: RunRecord, runs: ReadonlyArray<RunRecord>) => {
	const shortId = shortRunId(run, runs);
	return runs.some((candidate) => candidate.presetName === shortId)
		? `${run.projectName}/${run.presetName} --run ${shortId}`
		: shortId;
};
