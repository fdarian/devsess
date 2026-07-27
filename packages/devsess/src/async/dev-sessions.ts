import { Effect, Layer } from 'effect';
import { DevSessions } from '../dev-sessions';
import type { DevServices } from './platform';
import { type DevSession, toAsyncSession } from './session';

export type DevSessionManager = {
	readonly dir: string;
	getSessions(): Promise<Array<DevSession>>;
	createSession(): Promise<DevSession>;
	getLatestOrCreate(): Promise<DevSession>;
};

/**
 * Creates a manager for slug-named dev session directories under
 * `<rootDir>/.data/sessions`, using the caller-supplied platform `services` layer
 * (e.g. `NodeServices.layer`). Same `rootDir` convention as `DevSessions.layerAt` — the
 * CLI facade and this one agree on where sessions live given the same root.
 *
 * `DevSessions.layerAt` only wires lazy service methods when built (no directory IO
 * happens at build time — see `src/dev-sessions.ts`), so it's cheap to re-provide the
 * same `layer` value on every call rather than resolving a shared runtime once.
 */
export const createDevSessions = (
	rootDir: string,
	services: Layer.Layer<DevServices>,
): DevSessionManager => {
	const layer = DevSessions.layerAt(rootDir).pipe(Layer.provide(services));

	const run = <A, E>(effect: Effect.Effect<A, E, DevSessions>): Promise<A> =>
		Effect.runPromise(Effect.provide(effect, layer));

	return {
		// Matches the service's own `dir`, which is `rootDir` verbatim — safe to read synchronously.
		dir: rootDir,
		getSessions: () =>
			run(DevSessions.use((sessions) => sessions.getSessions)).then(
				(sessions) => sessions.map(toAsyncSession),
			),
		createSession: () =>
			run(DevSessions.use((sessions) => sessions.createSession)).then(
				toAsyncSession,
			),
		getLatestOrCreate: () =>
			run(DevSessions.use((sessions) => sessions.getLatestOrCreate)).then(
				toAsyncSession,
			),
	};
};
