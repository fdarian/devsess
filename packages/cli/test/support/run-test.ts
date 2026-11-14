import { NodeServices } from '@effect/platform-node';
import { Effect } from 'effect';

/**
 * Provides the Node platform services (`FileSystem`, `Path`, ...) ambiently over an
 * entire test effect. Everything under test reads/writes real files via `effect/FileSystem`
 * and `effect/Path`, so wrap the *whole* `Effect.gen` body in this — `Effect.provide(NodeServices.layer)`
 * scoped narrowly around a single `yield*` sub-expression only satisfies that sub-expression,
 * leaving the rest of the body without `FileSystem`/`Path` in scope.
 */
export const runTest = <A, E, R>(
	effect: Effect.Effect<A, E, R | NodeServices.NodeServices>,
) => effect.pipe(Effect.provide(NodeServices.layer));
