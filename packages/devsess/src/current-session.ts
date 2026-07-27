import { Context, Effect, Layer } from 'effect';
import type { PlatformError } from 'effect/PlatformError';
import { type DevSession, DevSessions } from './dev-sessions';

/**
 * The dev session resolved for a single command run. `yield* CurrentSession` always
 * gives a plain `DevSession` — never a wrapper effect to unwrap — so provide whichever
 * layer resolves it (`layer` or the test-only `layerOf(session)`) close to where it's
 * actually used.
 */
export class CurrentSession extends Context.Service<
	CurrentSession,
	DevSession
>()('devsess/CurrentSession') {
	/**
	 * Resolves the session via `DevSessions#getLatestOrCreate`. Provide this around a
	 * command's own handler effect, not the whole CLI program: a `Layer`'s build effect
	 * runs the moment it's provided, regardless of what the effect it wraps ends up
	 * doing — wrapping `Command.run` itself would create a session for `--help`,
	 * `--version`, or a bad flag too, none of which ever reach a handler.
	 */
	static readonly layer: Layer.Layer<
		CurrentSession,
		PlatformError,
		DevSessions
	> = Layer.effect(
		CurrentSession,
		Effect.gen(function* () {
			const sessions = yield* DevSessions;
			return yield* sessions.getLatestOrCreate;
		}),
	);

	/** Pins an explicit session instead of resolving one via `DevSessions` — for tests. */
	static readonly layerOf = (session: DevSession) =>
		Layer.succeed(CurrentSession, session);
}
