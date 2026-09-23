import { Effect } from 'effect';
import type { FileSystem } from 'effect/FileSystem';
import type { Path } from 'effect/Path';
import type { Terminal } from 'effect/Terminal';
import { Prompt } from 'effect/unstable/cli';
import type { RunRecord } from '../registry';
import { runSelector, shortRunId } from '../run-id';
import { CommandError, type CommandOptions } from './daemon';

export const chooseServices = (
	run: RunRecord,
	options: CommandOptions,
	command: 'tail' | 'attach',
	interactive = process.stdin.isTTY === true && process.stdout.isTTY === true,
	runs: ReadonlyArray<RunRecord> = [run],
): Effect.Effect<
	ReadonlyArray<RunRecord['services'][number]>,
	CommandError,
	FileSystem | Path | Terminal
> => {
	const available =
		command === 'attach'
			? run.services.filter(
					(service) =>
						service.state === 'running' || service.state === 'starting',
				)
			: run.services;
	if (options.allServices === true) {
		if (command === 'attach')
			return new CommandError({
				message:
					'Attach requires one service; --all-services is only for tail.',
			});
		if (options.service !== undefined)
			return new CommandError({
				message: 'Use either --service or --all-services.',
			});
		return Effect.succeed(available);
	}
	const services =
		options.service === undefined
			? available
			: available.filter((service) => service.name === options.service);
	const service = services[0];
	if (services.length === 1 && service !== undefined)
		return Effect.succeed([service]);
	const positionalId =
		options.preset !== undefined &&
		options.preset !== run.presetName &&
		run.runId.startsWith(options.preset);
	const selector = positionalId
		? runSelector(run, runs)
		: `${run.projectName}/${run.presetName}${options.runId === undefined ? '' : ` --run ${shortRunId(run, runs)}`}`;
	const prefix = `devsess ${command} ${selector}`;
	if (services.length === 0)
		return new CommandError({
			message: `No matching ${command === 'attach' ? 'live ' : ''}service${options.service === undefined ? '' : ` named ${options.service}`} in ${run.projectName}/${run.presetName}. Available: ${available.map((candidate) => candidate.name).join(', ')}. See \`devsess status\`.`,
		});
	if (interactive)
		return Prompt.run(
			Prompt.select({
				message: `Choose a service to ${command}`,
				choices: [
					...(command === 'tail'
						? [{ title: 'All services', value: available }]
						: []),
					...services.map((candidate) => ({
						title: `${candidate.name} (${candidate.state})`,
						value: [candidate],
					})),
				],
			}),
		).pipe(
			Effect.catchTag('QuitError', () => Effect.interrupt),
			Effect.mapError(
				() => new CommandError({ message: 'Service selection cancelled' }),
			),
		);
	return new CommandError({
		message: `Multiple services in ${run.projectName}/${run.presetName}:\n${services.map((candidate) => `  ${candidate.name} — ${prefix} --service ${candidate.name}`).join('\n')}${command === 'tail' ? `\n  all services — ${prefix} --all-services` : ''}`,
	});
};
