import { Effect } from 'effect';
import { FileSystem } from 'effect/FileSystem';
import { Path } from 'effect/Path';
import * as S from 'effect/Schema';
import type { DevSession } from '../dev-sessions';

function getPath(session: DevSession) {
	return session.path('sess.json');
}

function read(filePath: string) {
	return Effect.gen(function* () {
		const fs = yield* FileSystem;
		if (!(yield* fs.exists(filePath))) {
			return null;
		}
		return yield* fs.readFileString(filePath);
	});
}

export namespace SessionState {
	type Shape = S.Top;

	export function slot<T extends Shape>(schema: T) {
		return {
			read: (session: DevSession) =>
				Effect.gen(function* () {
					const filePath = yield* getPath(session);
					const content = yield* read(filePath);
					if (content == null) return null;
					return yield* S.decodeEffect(S.fromJsonString(schema))(content).pipe(
						Effect.catchTag('SchemaError', () => Effect.succeed(null)),
					);
				}),
			write: (session: DevSession, data: T['Type']) =>
				Effect.gen(function* () {
					const fs = yield* FileSystem;
					const path = yield* Path;
					const filePath = yield* getPath(session);
					yield* fs.makeDirectory(path.dirname(filePath), { recursive: true });
					const existing = yield* read(filePath);
					const parsed = JSON.parse(existing ?? '{}') as Record<
						string,
						unknown
					>;
					const merged = { ...parsed, ...(data as Record<string, unknown>) };
					yield* fs.writeFileString(filePath, JSON.stringify(merged));
				}),
		};
	}
}
