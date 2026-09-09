#!/usr/bin/env node

import { NodeRuntime, NodeServices, NodeTerminal } from '@effect/platform-node';
import { Effect, Layer, Option } from 'effect';
import { Terminal } from 'effect/Terminal';
import { Argument, Command, Flag } from 'effect/unstable/cli';
import { attach, list, start, stop, tail } from './cli/commands';
import { DaemonLifecycle } from './cli/lifecycle';

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
	{ ...options, preset: optionalPreset },
	(input) => stop(commandOptions(input)),
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
const daemonCommand = Command.make(
	'__daemon',
	{
		dataDirectory: Flag.string('data-directory'),
		socketPath: Flag.string('socket-path'),
	},
	(input) =>
		Effect.never.pipe(
			Effect.provide(
				DaemonLifecycle.layer({
					dataDirectory: input.dataDirectory,
					socketPath: input.socketPath,
				}),
			),
		),
).pipe(Command.withHidden);

const app = Command.make('devsess', {}).pipe(
	Command.withSubcommands([
		startCommand,
		listCommand,
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
	Command.runWith(app, { version: '0.3.0' })(process.argv.slice(2)).pipe(
		Effect.scoped,
		Effect.provide(services),
	),
);
