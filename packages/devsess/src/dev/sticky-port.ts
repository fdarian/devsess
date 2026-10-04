import { Effect } from 'effect';
import { FileSystem } from 'effect/FileSystem';
import { Path } from 'effect/Path';
import * as S from 'effect/Schema';
import getPort from 'get-port';
import type { DevSession } from '../dev-sessions';
import { acquireFileLock } from '../lock';
import { SessionState, SessionStateError } from './session-state';

const DEFAULT_NAME = 'default';

/**
 * Reads both the current `{ ports: Record<string, number> }` shape and the legacy
 * top-level `{ port: number }` shape, so a session written before named ports existed
 * still yields its remembered port (as `default`). Writes only ever use `ports` —
 * the legacy `port` key is never touched again once the new shape is written.
 */
const StickyPorts = SessionState.slot(
	S.Struct({
		ports: S.optional(S.Record(S.String, S.Number)),
		port: S.optional(S.Number),
	}),
);

export const getStickyPort = (
	session: DevSession,
	options?: { name?: string },
) =>
	Effect.gen(function* () {
		const name = options?.name ?? DEFAULT_NAME;
		const fs = yield* FileSystem;
		const path = yield* Path;
		const statePath = yield* session.path('sess.json');
		yield* fs.makeDirectory(path.dirname(statePath), { recursive: true });
		yield* Effect.acquireRelease(
			acquireFileLock(statePath).pipe(
				Effect.mapError(
					(cause) =>
						new SessionStateError({
							message: 'Failed to lock sticky ports',
							cause,
						}),
				),
			),
			(release) => Effect.promise(() => release()),
		);

		const file = yield* StickyPorts.read(session);
		const ports =
			file?.ports ??
			(file?.port !== undefined ? { [DEFAULT_NAME]: file.port } : {});

		const preferred = ports[name];
		const exclude = Object.entries(ports)
			.filter((entry) => entry[0] !== name)
			.map((entry) => entry[1]);

		const port = yield* Effect.promise(async () =>
			getPort({
				port: preferred !== undefined ? [preferred] : undefined,
				...(exclude.length > 0 ? { exclude } : {}),
			}),
		);

		yield* StickyPorts.write(session, { ports: { ...ports, [name]: port } });

		return port;
	}).pipe(Effect.scoped);
