import { Effect, type Scope } from 'effect';
import type { FileSystem } from 'effect/FileSystem';
import type { Path } from 'effect/Path';
import type { ChildProcessSpawner } from 'effect/unstable/process/ChildProcessSpawner';
import { type CommandConfig, runDevCli } from '../dev/run-dev-cli';
import {
	awaitRunningSignal,
	publishRunningSignal,
	resolveSiblingDir,
	runningSignalPath,
} from '../dev/running-signal';
import { getStickyPort } from '../dev/sticky-port';
import { runManagedSubprocess } from '../dev/subprocess';
import { DevSessions } from '../dev-sessions';
import type { DevPlatform } from '../platform';
import { type DevSession, toAsyncSession } from './session';

/** Promise-returning mirror of the Effect core's `RunContext` (see `src/dev/define-cli.ts`). */
type AsyncRunContext = {
	session: () => Promise<DevSession>;
	getStickyPort: () => Promise<number>;
	runManagedSubprocess: (
		...args: Parameters<typeof runManagedSubprocess>
	) => Promise<Effect.Success<ReturnType<typeof runManagedSubprocess>>>;
	publishRunning: (data: unknown) => Promise<void>;
	awaitRunning: <T>(pkg: string) => Promise<T>;
};

export const defineDevCli = (config: {
	name: string;
	dir: string;
	options?: CommandConfig;
	platform: DevPlatform;
	run: (
		ctx: AsyncRunContext,
		opts: Record<string, unknown>,
	) => Promise<void> | void;
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

				// Capture the process-lifetime context (the Scope opened by `runDevCli`'s
				// outer `Effect.scoped`, plus DevSessions | FileSystem | Path | ChildProcessSpawner).
				// Running each ctx helper with this captured context — instead of a fresh,
				// transient `Effect.runPromise` per call — attaches its scoped resources
				// (managed subprocess, running-signal file) to that process-lifetime scope,
				// so they only release when the CLI process ends, not right after the Promise settles.
				const services = yield* Effect.context<
					DevSessions | FileSystem | Path | ChildProcessSpawner | Scope.Scope
				>();

				const ctx: AsyncRunContext = {
					session: () =>
						Effect.runPromiseWith(services)(session).then(toAsyncSession),
					getStickyPort: () =>
						Effect.runPromiseWith(services)(
							Effect.flatMap(session, getStickyPort),
						),
					runManagedSubprocess: (...args) =>
						Effect.runPromiseWith(services)(runManagedSubprocess(...args)),
					publishRunning: (data) =>
						Effect.runPromiseWith(services)(
							publishRunningSignal(runningSignalPath(config.dir), data),
						),
					awaitRunning: <T>(pkg: string) =>
						Effect.runPromiseWith(services)(
							awaitRunningSignal<T>(
								runningSignalPath(resolveSiblingDir(pkg, config.dir)),
								{ parse: (raw) => JSON.parse(raw) as T },
							),
						),
				};

				yield* Effect.promise(() => Promise.resolve(config.run(ctx, opts)));
			}),
	});
