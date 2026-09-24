#!/usr/bin/env node

import { readFile } from 'node:fs/promises';
import { NodeRuntime, NodeServices, NodeTerminal } from '@effect/platform-node';
import { Effect, Layer, Option } from 'effect';
import { Terminal } from 'effect/Terminal';
import { Argument, Command, Flag } from 'effect/unstable/cli';
import devsessPackageJson from '../package.json' with { type: 'json' };
import { attach } from './cli/commands/attach';
import { CommandError, daemonCommand } from './cli/commands/daemon';
import { daemonControlCommand } from './cli/commands/daemon-control';
import { list } from './cli/commands/list';
import { start } from './cli/commands/start';
import { status } from './cli/commands/status';
import { stop } from './cli/commands/stop';
import { tail } from './cli/commands/tail';

const optionalPreset = Argument.string('preset').pipe(
	Argument.withDescription('Preset name or project/preset selector.'),
	Argument.optional,
);
const optionalString = (name: string, description: string) =>
	Flag.string(name).pipe(Flag.withDescription(description), Flag.optional);
const options = {
	project: optionalString('project', 'Select a configured project by name.'),
	service: Flag.string('service').pipe(
		Flag.withAlias('s'),
		Flag.withDescription('Select one service by name.'),
		Flag.optional,
	),
	configPath: optionalString('config', 'Read configuration from this file.'),
};
const value = <A>(option: Option.Option<A>) => Option.getOrUndefined(option);
const commandOptions = (input: {
	project: Option.Option<string>;
	service: Option.Option<string>;
	configPath: Option.Option<string>;
	preset: Option.Option<string>;
}) => ({
	project: value(input.project),
	service: value(input.service),
	configPath: value(input.configPath),
	preset: value(input.preset),
});
const selectedOptions = (
	input: Parameters<typeof commandOptions>[0] & {
		runId: Option.Option<string>;
	},
) => ({
	...commandOptions(input),
	runId: value(input.runId),
});

const startCommand = Command.make(
	'start',
	{ ...options, preset: optionalPreset },
	(input) => start(commandOptions(input), process.stdin.isTTY),
).pipe(Command.withDescription('Start a preset of development services.'));
const stopCommand = Command.make(
	'stop',
	{
		...options,
		preset: optionalPreset,
		runId: optionalString('run', 'Select a run by its ID or unique prefix.'),
		force: Flag.boolean('force').pipe(
			Flag.withDescription('Allow stopping an orphaned process group.'),
		),
	},
	(input) => stop({ ...selectedOptions(input), force: input.force }),
).pipe(Command.withDescription('Stop an active run and its services.'));
const tailCommand = Command.make(
	'tail',
	{
		...options,
		preset: optionalPreset,
		runId: optionalString('run', 'Select a run by its ID or unique prefix.'),
		allServices: Flag.boolean('all-services').pipe(
			Flag.withDescription('Print output from every service in the run.'),
		),
		lines: Flag.integer('lines').pipe(
			Flag.withAlias('n'),
			Flag.withDescription('Print the last N lines per service (default: 10).'),
			Flag.withDefault(10),
		),
		follow: Flag.boolean('follow').pipe(
			Flag.withAlias('f'),
			Flag.withDescription(
				'Keep streaming new output until the service exits.',
			),
		),
	},
	(input) =>
		input.lines < 0
			? Effect.fail(
					new CommandError({
						message: 'The number of lines must be non-negative',
					}),
				)
			: tail({
					...selectedOptions(input),
					allServices: input.allServices,
					lines: input.lines,
					follow: input.follow,
				}),
).pipe(
	Command.withDescription(
		'Print recent service output, optionally following live output.',
	),
);
const attachCommand = Command.make(
	'attach',
	{
		...options,
		preset: optionalPreset,
		runId: optionalString('run', 'Select a run by its ID or unique prefix.'),
	},
	(input) => attach(selectedOptions(input)),
).pipe(Command.withDescription('Connect your terminal to a running service.'));
const statusCommand = Command.make(
	'status',
	{
		project: options.project,
		all: Flag.boolean('all').pipe(
			Flag.withAlias('a'),
			Flag.withDescription('Show all active runs in full detail.'),
		),
	},
	(input) => status({ project: value(input.project), all: input.all }),
).pipe(Command.withDescription('Show active runs and recent service status.'));
const listCommand = Command.make(
	'list',
	{ project: options.project, configPath: options.configPath },
	(input) =>
		list({
			project: value(input.project),
			configPath: value(input.configPath),
		}),
).pipe(Command.withDescription('List configured presets for this checkout.'));
const docsCommand = Command.make('docs', {}, () =>
	Effect.tryPromise({
		try: () => readFile(new URL('../CLI.md', import.meta.url), 'utf8'),
		catch: (cause) =>
			new CommandError({
				message: 'Could not read the bundled CLI reference',
				cause,
			}),
	}).pipe(
		Effect.flatMap((reference) =>
			Effect.sync(() => process.stdout.write(reference)),
		),
	),
).pipe(
	Command.withDescription('Print the complete CLI reference as Markdown.'),
);
const app = Command.make('devsess', {}).pipe(
	Command.withDescription(
		'Run named presets of development services per project or checkout through a shared per-user daemon.',
	),
	Command.withExamples([
		{
			command: 'devsess start',
			description: 'Start a preset for this checkout.',
		},
		{
			command: 'devsess status',
			description: 'See running services and their readiness.',
		},
		{
			command: 'devsess tail -n 50',
			description: 'Read the latest 50 log lines.',
		},
		{
			command: 'devsess tail -f --all-services',
			description: 'Follow output from every service.',
		},
		{ command: 'devsess stop', description: 'Stop the selected run.' },
		{
			command: 'devsess docs',
			description: 'Print the full CLI reference as Markdown.',
		},
	]),
	Command.withSubcommands([
		startCommand,
		listCommand,
		statusCommand,
		stopCommand,
		tailCommand,
		attachCommand,
		docsCommand,
		daemonControlCommand,
		daemonCommand,
	]),
);

const services = Layer.mergeAll(
	NodeServices.layer,
	Layer.effect(Terminal, NodeTerminal.make()),
);

NodeRuntime.runMain(
	Command.runWith(app, { version: devsessPackageJson.version })(
		process.argv.slice(2),
	).pipe(Effect.scoped, Effect.provide(services)),
);
