import type { Layer } from 'effect';
import type * as S from 'effect/Schema';
import { SessionState as EffectSessionState } from '../dev/session-state';
import type { DevServices } from './platform';
import { run } from './run';
import { type DevSession, unwrapSession } from './session';

export namespace SessionState {
	// Decoding must run without extra context beyond the platform `services` layer, so
	// schemas cannot require decoding services of their own.
	type Shape = S.Codec<unknown, unknown, never>;

	export function slot<T extends Shape>(
		schema: T,
		services: Layer.Layer<DevServices>,
	) {
		const effectSlot = EffectSessionState.slot(schema);
		return {
			read: (session: DevSession): Promise<T['Type'] | null> =>
				run(effectSlot.read(unwrapSession(session)), services),
			write: (session: DevSession, data: T['Type']): Promise<void> =>
				run(effectSlot.write(unwrapSession(session), data), services),
		};
	}
}
