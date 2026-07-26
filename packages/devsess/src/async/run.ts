import { NodeServices } from '@effect/platform-node';
import { Effect, type Scope } from 'effect';

const nodeLayer = NodeServices.layer;

/** Runs an Effect that only needs the shared Node platform services (+ an optional Scope) as a Promise. */
export const runNode = <A, E>(
	effect: Effect.Effect<A, E, NodeServices.NodeServices | Scope.Scope>,
): Promise<A> =>
	Effect.runPromise(Effect.scoped(Effect.provide(effect, nodeLayer)));
