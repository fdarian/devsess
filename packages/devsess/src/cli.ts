#!/usr/bin/env node

import { NodeRuntime, NodeServices, NodeTerminal } from '@effect/platform-node';
import { Effect, Layer, Option } from 'effect';
import { Terminal } from 'effect/Terminal';
import { Argument, Command, Flag } from 'effect/unstable/cli';
import devsessPackageJson from '../package.json' with { type: 'json' };
import { attach } from './cli/commands/attach';
import { daemonCommand } from './cli/commands/daemon';
import { list } from './cli/commands/list';
import { presets } from './cli/commands/presets';
import { start } from './cli/commands/start';
import { stop } from './cli/commands/stop';
import { tail } from './cli/commands/tail';

const optionalPreset = Argument.string('preset').pipe(Argument.optional);
const optionalString = (name: string) => Flag.string(name).pipe(Flag.optional);
const options = {
	project: optionalString('project'),
	service: optionalString('service'),
	configPath: optionalString('config'),
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

const startCommand = Command.make(
	'start',
	{ ...options, preset: optionalPreset },
	(input) => start(commandOptions(input), process.stdin.isTTY),
);
const stopCommand = Command.make(
	'stop',
	{ ...options, preset: optionalPreset, force: Flag.boolean('force') },
	(input) => stop({ ...commandOptions(input), force: input.force }),
);
const tailCommand = Command.make(
	'tail',
	{ ...options, preset: optionalPreset },
	(input) => tail(commandOptions(input)),
);
const attachCommand = Command.make(
	'attach',
	{ ...options, preset: optionalPreset },
	(input) => attach(commandOptions(input)),
);
const listCommand = Command.make('list', options, (input) =>
	list({
		project: value(input.project),
		service: value(input.service),
		configPath: value(input.configPath),
	}),
);
const presetsCommand = Command.make(
	'presets',
	{ project: options.project, configPath: options.configPath },
	(input) =>
		presets({
			project: value(input.project),
			configPath: value(input.configPath),
		}),
);
const app = Command.make('devsess', {}).pipe(
	Command.withSubcommands([
		startCommand,
		listCommand,
		presetsCommand,
		stopCommand,
		tailCommand,
		attachCommand,
		daemonCommand,
	]),
);

const services = Layer.mergeAll(
	NodeServices.layer,
	Layer.effect(
		Terminal,
		NodeTerminal.make(() => false),
	),
);

NodeRuntime.runMain(
	Command.runWith(app, { version: devsessPackageJson.version })(
		process.argv.slice(2),
	).pipe(Effect.scoped, Effect.provide(services)),
);
