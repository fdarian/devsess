import { realpathSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import * as cli from '@effect/cli';
import type { PlatformError } from '@effect/platform/Error';
import type { FileSystem } from '@effect/platform/FileSystem';
import type { Path } from '@effect/platform/Path';
import { NodeContext, NodeRuntime } from '@effect/platform-node';
import { Effect, Layer, type Scope } from 'effect';
import {
	type DevSession,
	DevSessions,
	makeDevSessionsLayer,
} from '../dev-sessions';
import { awaitRunningSignal, publishRunningSignal } from './running-signal';
import { getStickyPort } from './sticky-port';
import { runManagedSubprocess } from './subprocess';

const RUNNING_SIGNAL_FILE = '.data/running.json';

const runningSignalPath = (dir: string) => join(dir, RUNNING_SIGNAL_FILE);

const resolveSiblingDir = (spec: string, fromDir: string) => {
	if (spec.startsWith('.') || spec.startsWith('/')) {
		return resolve(fromDir, spec);
	}
	const require = createRequire(join(fromDir, 'package.json'));
	const pkgJsonPath = require.resolve(`${spec}/package.json`);
	return dirname(realpathSync(pkgJsonPath));
};

type RunContext = {
	session: Effect.Effect<DevSession, PlatformError>;
	getStickyPort: () => ReturnType<typeof getStickyPort>;
	runManagedSubprocess: typeof runManagedSubprocess;
	publishRunning: (
		data: unknown,
	) => Effect.Effect<void, PlatformError, Scope.Scope | FileSystem | Path>;
	awaitRunning: <T>(
		pkg: string,
	) => Effect.Effect<T, PlatformError, FileSystem | Path>;
};

type RunEffect = Effect.Effect<
	void,
	unknown,
	DevSessions | NodeContext.NodeContext | Scope.Scope
>;

type CommandConfig = typeof cli.Command.make extends (
	name: string,
	config: infer C,
	...rest: Array<unknown>
) => unknown
	? C
	: never;

export const defineDevCli = (config: {
	name: string;
	dir: string;
	options?: CommandConfig;
	run: (ctx: RunContext, opts: Record<string, unknown>) => RunEffect;
}): ((argv: string[]) => void) => {
	const command = cli.Command.make(config.name, config.options ?? {}, (opts) =>
		Effect.gen(function* () {
			const sessions = yield* DevSessions;
			const session = yield* Effect.cached(sessions.getLatestOrCreate);
			return yield* config.run(
				{
					session,
					getStickyPort: () => Effect.flatMap(session, getStickyPort),
					runManagedSubprocess,
					publishRunning: (data) =>
						publishRunningSignal(runningSignalPath(config.dir), data),
					awaitRunning: <T>(pkg: string) =>
						awaitRunningSignal<T>(
							runningSignalPath(resolveSiblingDir(pkg, config.dir)),
							{ parse: (raw) => JSON.parse(raw) as T },
						),
				},
				opts as Record<string, unknown>,
			);
		}),
	);

	return (argv) => {
		const layer = makeDevSessionsLayer(join(config.dir, '.data/sessions')).pipe(
			Layer.provideMerge(NodeContext.layer),
			Layer.provideMerge(Layer.scope),
		);

		const program = cli.Command.run(command, {
			name: config.name,
			version: '0.0.0',
		})(argv);

		NodeRuntime.runMain(Effect.provide(program, layer));
	};
};
