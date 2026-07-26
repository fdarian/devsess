import { Effect, type Layer, type Scope } from 'effect';
import type { DevServices } from '../platform';

/** Runs an Effect that only needs the caller-supplied platform services (+ an optional Scope) as a Promise. */
export const run = <A, E>(
	effect: Effect.Effect<A, E, DevServices | Scope.Scope>,
	services: Layer.Layer<DevServices>,
): Promise<A> =>
	Effect.runPromise(Effect.scoped(Effect.provide(effect, services)));
