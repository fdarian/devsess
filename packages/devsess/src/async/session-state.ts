import type * as S from 'effect/Schema';
import { SessionState as EffectSessionState } from '../dev/session-state';
import { runNode } from './run';
import { type DevSession, unwrapSession } from './session';

export namespace SessionState {
	// Decoding must run without extra context (only `NodeServices | Scope` are
	// available via `runNode`), so schemas cannot require decoding services.
	type Shape = S.Codec<unknown, unknown, never>;

	export function slot<T extends Shape>(schema: T) {
		const effectSlot = EffectSessionState.slot(schema);
		return {
			read: (session: DevSession): Promise<T['Type'] | null> =>
				runNode(effectSlot.read(unwrapSession(session))),
			write: (session: DevSession, data: T['Type']): Promise<void> =>
				runNode(effectSlot.write(unwrapSession(session), data)),
		};
	}
}
