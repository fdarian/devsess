import { Effect } from 'effect';
import * as S from 'effect/Schema';
import getPort from 'get-port';
import type { DevSession } from '../dev-sessions';
import { SessionState } from './session-state';

const StickyPort = SessionState.slot(S.Struct({ port: S.Number }));

export const getStickyPort = (session: DevSession) =>
	Effect.gen(function* () {
		const file = yield* StickyPort.read(session);
		const preferred = file?.port;

		const port = yield* Effect.promise(async () =>
			getPort({
				port: preferred !== undefined ? [preferred] : undefined,
			}),
		);

		yield* StickyPort.write(session, { port });

		return port;
	});
