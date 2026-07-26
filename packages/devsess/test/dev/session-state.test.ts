import { describe, expect, it } from '@effect/vitest';
import { Effect } from 'effect';
import { FileSystem } from 'effect/FileSystem';
import * as S from 'effect/Schema';
import { SessionState, SessionStateError } from '../../src/dev/session-state';
import { DevSessions } from '../../src/dev-sessions';
import { makeTestDevSessionsLayer } from '../support/dev-sessions-layer';
import { runTest } from '../support/run-test';
import { makeTempDir } from '../support/temp-dir';

const Config = SessionState.slot(S.Struct({ port: S.Number }));

describe('SessionState', () => {
	it.effect('round-trips written data', () =>
		runTest(
			Effect.gen(function* () {
				const rootDir = yield* makeTempDir;
				const devSessions = yield* DevSessions.pipe(
					Effect.provide(makeTestDevSessionsLayer(rootDir)),
				);
				const session = yield* devSessions.createSession;

				yield* Config.write(session, { port: 4321 });
				const result = yield* Config.read(session);

				expect(result).toEqual({ port: 4321 });
			}),
		),
	);

	it.effect('reading a nonexistent sess.json returns null', () =>
		runTest(
			Effect.gen(function* () {
				const rootDir = yield* makeTempDir;
				const devSessions = yield* DevSessions.pipe(
					Effect.provide(makeTestDevSessionsLayer(rootDir)),
				);
				const session = yield* devSessions.createSession;

				const result = yield* Config.read(session);

				expect(result).toBeNull();
			}),
		),
	);

	it.effect('reading content that fails schema decode returns null', () =>
		runTest(
			Effect.gen(function* () {
				const rootDir = yield* makeTempDir;
				const devSessions = yield* DevSessions.pipe(
					Effect.provide(makeTestDevSessionsLayer(rootDir)),
				);
				const session = yield* devSessions.createSession;
				const filePath = yield* session.path('sess.json');
				const fs = yield* FileSystem;
				yield* fs.writeFileString(
					filePath,
					JSON.stringify({ port: 'not-a-number' }),
				);

				const result = yield* Config.read(session);

				expect(result).toBeNull();
			}),
		),
	);

	it.effect(
		'two slots sharing sess.json: writing slot B preserves slot A keys',
		() =>
			runTest(
				Effect.gen(function* () {
					const rootDir = yield* makeTempDir;
					const devSessions = yield* DevSessions.pipe(
						Effect.provide(makeTestDevSessionsLayer(rootDir)),
					);
					const session = yield* devSessions.createSession;

					const SlotA = SessionState.slot(S.Struct({ a: S.String }));
					const SlotB = SessionState.slot(S.Struct({ b: S.Number }));

					yield* SlotA.write(session, { a: 'hello' });
					yield* SlotB.write(session, { b: 7 });

					expect(yield* SlotA.read(session)).toEqual({ a: 'hello' });
					expect(yield* SlotB.read(session)).toEqual({ b: 7 });
				}),
			),
	);

	it.effect('slots with a colliding key name overwrite each other', () =>
		runTest(
			Effect.gen(function* () {
				const rootDir = yield* makeTempDir;
				const devSessions = yield* DevSessions.pipe(
					Effect.provide(makeTestDevSessionsLayer(rootDir)),
				);
				const session = yield* devSessions.createSession;

				const SlotA = SessionState.slot(S.Struct({ shared: S.String }));
				const SlotB = SessionState.slot(S.Struct({ shared: S.Number }));

				yield* SlotA.write(session, { shared: 'text' });
				yield* SlotB.write(session, { shared: 42 });

				// SlotB's write overwrote the `shared` key, so decoding it back through
				// SlotA's string schema now fails and degrades to null.
				expect(yield* SlotA.read(session)).toBeNull();
				expect(yield* SlotB.read(session)).toEqual({ shared: 42 });
			}),
		),
	);

	it.effect(
		'writing over a corrupt sess.json fails with a SessionStateError',
		() =>
			runTest(
				Effect.gen(function* () {
					const rootDir = yield* makeTempDir;
					const devSessions = yield* DevSessions.pipe(
						Effect.provide(makeTestDevSessionsLayer(rootDir)),
					);
					const session = yield* devSessions.createSession;
					const filePath = yield* session.path('sess.json');
					const fs = yield* FileSystem;
					yield* fs.writeFileString(filePath, '{not valid json');

					const failure = yield* Config.write(session, { port: 1 }).pipe(
						Effect.flip,
					);

					expect(failure).toBeInstanceOf(SessionStateError);
					expect(failure._tag).toBe('SessionStateError');
				}),
			),
	);
});
