import type { Effect, Layer } from 'effect';
import type { FileSystem } from 'effect/FileSystem';
import type { Path } from 'effect/Path';
import type * as Runtime from 'effect/Runtime';
import type { Stdio } from 'effect/Stdio';
import type { Terminal } from 'effect/Terminal';
import type { ChildProcessSpawner } from 'effect/unstable/process/ChildProcessSpawner';

/**
 * Core `effect` service tags this library needs from the caller-supplied platform.
 * `effect/unstable/cli`'s `Command.runWith` pulls in `Stdio`/`Terminal` alongside the
 * `FileSystem`/`Path`/`ChildProcessSpawner` the library's own code depends on directly.
 *
 * Both `@effect/platform-node`'s `NodeServices.NodeServices` and `@effect/platform-bun`'s
 * `BunServices.BunServices` are unions of these same core tags (plus `Crypto`, which this
 * library never uses), so either `.layer` satisfies this narrower requirement.
 */
export type DevServices =
	| ChildProcessSpawner
	| FileSystem
	| Path
	| Stdio
	| Terminal;

type RunMainOptions = {
	readonly disableErrorReporting?: boolean | undefined;
	readonly teardown?: Runtime.Teardown | undefined;
};

/**
 * Structurally identical to `NodeRuntime.runMain` and `BunRuntime.runMain` (both are the
 * same function, re-exported from `@effect/platform-node-shared`), so either is assignable
 * here with no cast.
 */
type RunMain = {
	(options?: RunMainOptions): <E, A>(effect: Effect.Effect<A, E>) => void;
	<E, A>(effect: Effect.Effect<A, E>, options?: RunMainOptions): void;
};

/**
 * The platform a caller supplies so the library depends on no platform package of its
 * own, e.g. `{ services: NodeServices.layer, runMain: NodeRuntime.runMain }` or the `Bun`
 * equivalents.
 */
export type DevPlatform = {
	readonly services: Layer.Layer<DevServices>;
	readonly runMain: RunMain;
};
