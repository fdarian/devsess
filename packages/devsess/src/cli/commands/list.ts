import { Effect } from 'effect';
import { type CommandOptions, resolveCurrentRuns, write } from './daemon';

export const list = (options: CommandOptions) =>
	resolveCurrentRuns(options).pipe(
		Effect.flatMap((resolved) =>
			Effect.forEach(
				[
					'Current project:',
					...resolved.current.map(
						(run) => `  ${run.projectName}/${run.presetName} ${run.state}`,
					),
					'Elsewhere:',
					...resolved.runs
						.filter((run) => !resolved.current.includes(run))
						.map(
							(run) => `  ${run.projectName}/${run.presetName} ${run.state}`,
						),
				],
				write,
				{ discard: true },
			),
		),
	);
