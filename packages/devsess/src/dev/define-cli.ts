import { Effect, type Scope } from 'effect';
import type { FileSystem } from 'effect/FileSystem';
import type { Path } from 'effect/Path';
import type { PlatformError } from 'effect/PlatformError';
import { type DevSession, DevSessions } from '../dev-sessions';
import type { DevPlatform, DevServices } from '../platform';
import { type CommandConfig, runDevCli } from './run-dev-cli';
import {
	awaitRunningSignal,
	publishRunningSignal,
	resolveSiblingDir,
	runningSignalPath,
} from './running-signal';
import { getStickyPort } from './sticky-port';
import { runManagedSubprocess } from './subprocess';

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
	DevSessions | DevServices | Scope.Scope
>;

export const defineDevCli = (config: {
	name: string;
	dir: string;
	options?: CommandConfig;
	platform: DevPlatform;
	run: (ctx: RunContext, opts: Record<string, unknown>) => RunEffect;
}): ((argv: string[]) => void) =>
	runDevCli({
		name: config.name,
		dir: config.dir,
		options: config.options,
		platform: config.platform,
		makeHandler: (opts) =>
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
					opts,
				);
			}),
	});
