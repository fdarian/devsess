import { describe, expect, it } from '@effect/vitest';
import { Data, Effect, Exit, Layer } from 'effect';
import { FileSystem } from 'effect/FileSystem';
import * as S from 'effect/Schema';
import { CurrentSession } from '../../src/current-session';
import { SessionState } from '../../src/dev/session-state';
import { DevSessions } from '../../src/dev-sessions';
import { Service } from '../../src/services';
import { makeTestDevSessionsLayer } from '../support/dev-sessions-layer';
import { runTest } from '../support/run-test';
import { makeTempDir } from '../support/temp-dir';

const makeSession = Effect.gen(function* () {
	const rootDir = yield* makeTempDir;
	const sessions = yield* DevSessions.pipe(
		Effect.provide(makeTestDevSessionsLayer(rootDir)),
	);
	return yield* sessions.createSession;
});

class BrokeError extends Data.TaggedError('BrokeError') {}

const StoredPorts = SessionState.slot(
	S.Struct({ ports: S.Record(S.String, S.Number) }),
);

describe('Service.make', () => {
	it.effect(
		'passes sticky ports and a data dir to start, and merges its output with the ports',
		() =>
			runTest(
				Effect.gen(function* () {
					const fs = yield* FileSystem;
					const session = yield* makeSession;
					const events: string[] = [];
					const api = Service.make({
						name: 'api',
						ports: ['http', 'admin'],
						start: (ctx) =>
							Effect.acquireRelease(
								Effect.sync(() => {
									events.push('start');
									return { url: `http://127.0.0.1:${ctx.ports.http}` };
								}),
								() => Effect.sync(() => events.push('stop')),
							).pipe(
								Effect.tap(() =>
									fs
										.exists(ctx.dataDir)
										.pipe(Effect.map((exists) => expect(exists).toBe(true))),
								),
							),
					});

					const running = yield* Effect.scoped(
						Effect.gen(function* () {
							const running = yield* Service.run(session, api);
							expect(events).toEqual(['start']);
							return running;
						}),
					);

					expect(events).toEqual(['start', 'stop']);
					expect(running.url).toBe(`http://127.0.0.1:${running.ports.http}`);
					expect(running.ports.http).not.toBe(running.ports.admin);
					expect(yield* StoredPorts.read(session)).toEqual({
						ports: {
							'api:http': running.ports.http,
							'api:admin': running.ports.admin,
						},
					});
					// @ts-expect-error -- only declared port names are typed
					running.ports.missing;

					const again = yield* Effect.scoped(Service.run(session, api));
					expect(yield* StoredPorts.read(session)).toEqual({
						ports: {
							'api:http': again.ports.http,
							'api:admin': again.ports.admin,
						},
					});
				}),
			),
	);

	it.effect('keeps the handler error type instead of wrapping it', () =>
		runTest(
			Effect.gen(function* () {
				const session = yield* makeSession;
				const broken = Service.make({
					name: 'broken',
					start: () => new BrokeError(),
				});
				const exit = yield* Effect.exit(Service.run(session, broken));
				expect(exit).toEqual(Exit.fail(new BrokeError()));
			}),
		),
	);

	it.effect(
		'shares one instance between consumers when depended on through layers',
		() =>
			runTest(
				Effect.gen(function* () {
					const session = yield* makeSession;
					let starts = 0;
					const db = Service.make({
						name: 'db',
						ports: ['sql'],
						start: () => Effect.sync(() => ++starts),
					});
					const api = Service.make({
						name: 'api',
						ports: ['http'],
						start: () =>
							Effect.gen(function* () {
								const running = yield* db.key;
								return { databasePort: running.ports.sql };
							}),
					});

					const result = yield* Effect.gen(function* () {
						return {
							db: yield* db.key,
							api: yield* api.key,
						};
					}).pipe(
						Effect.provide(
							Layer.mergeAll(db.layer, api.layer.pipe(Layer.provide(db.layer))),
						),
						Effect.provide(CurrentSession.layerOf(session)),
						Effect.scoped,
					);

					expect(starts).toBe(1);
					expect(result.api.databasePort).toBe(result.db.ports.sql);
				}),
			),
	);
});
