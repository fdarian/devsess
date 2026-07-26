import { Effect } from 'effect';
import type { DevSession as EffectDevSession } from '../dev-sessions';

/** Non-enumerable, module-private key used to stash the Effect session on its async wrapper. */
const EFFECT_SESSION = Symbol('devsess/async/DevSession#effectSession');

export type DevSession = {
	readonly name: string;
	readonly lastModifiedAt: Date | null;
	path(relativePath: string): string;
	toString(): string;
};

/**
 * Wraps an Effect `DevSession` as a plain-async `DevSession`. The original Effect
 * session is stashed under `EFFECT_SESSION` so other async ops (e.g. `SessionState`)
 * can reuse the Effect core via `unwrapSession`.
 */
export const toAsyncSession = (session: EffectDevSession): DevSession => {
	const asyncSession: DevSession = {
		name: session.name,
		lastModifiedAt: session.lastModifiedAt,
		// Safe to run synchronously: the core `path` is `Effect.succeed(pathJoin(rel))`, pure.
		path: (relativePath) => Effect.runSync(session.path(relativePath)),
		toString: () => session.toString(),
	};

	Object.defineProperty(asyncSession, EFFECT_SESSION, {
		value: session,
		enumerable: false,
	});

	return asyncSession;
};

/** Recovers the Effect `DevSession` stashed by `toAsyncSession`. */
export const unwrapSession = (session: DevSession): EffectDevSession => {
	const effectSession = (
		session as unknown as Record<
			typeof EFFECT_SESSION,
			EffectDevSession | undefined
		>
	)[EFFECT_SESSION];
	if (effectSession === undefined) {
		throw new Error(
			'devsess/async: expected a DevSession created by this package, but the internal Effect session handle is missing',
		);
	}
	return effectSession;
};
