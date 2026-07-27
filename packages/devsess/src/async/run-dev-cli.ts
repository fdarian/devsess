import { Effect, Layer, type Scope } from 'effect';
import * as cli from 'effect/unstable/cli';
import { DevSessions } from '../dev-sessions';
import type { DevPlatform, DevServices } from './platform';

export type CommandConfig = typeof cli.Command.make extends (
	name: string,
	config: infer C,
	...rest: Array<unknown>
) => unknown
	? C
	: never;

type CliHandler = (
	opts: Record<string, unknown>,
) => Effect.Effect<void, unknown, DevSessions | DevServices | Scope.Scope>;

/**
 * CLI scaffolding for the plain-async `defineDevCli` facade (`src/async/define-cli.ts`):
 * builds the `cli.Command`, wires the per-project `DevSessions` + caller-supplied
 * platform services layer, and runs it via `platform.runMain`.
 */
export const runDevCli = (config: {
	name: string;
	dir: string;
	options?: CommandConfig;
	platform: DevPlatform;
	makeHandler: CliHandler;
}): ((argv: string[]) => void) => {
	const command = cli.Command.make(config.name, config.options ?? {}, (opts) =>
		config.makeHandler(opts as Record<string, unknown>),
	);

	return (argv) => {
		const layer = DevSessions.layerAt(config.dir).pipe(
			Layer.provideMerge(config.platform.services),
		);

		const program = cli.Command.runWith(command, {
			version: '0.0.0',
		})(argv);

		config.platform.runMain(Effect.scoped(Effect.provide(program, layer)));
	};
};
