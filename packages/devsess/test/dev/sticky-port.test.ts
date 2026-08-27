import { describe, expect, it } from '@effect/vitest';
import { Effect } from 'effect';
import * as S from 'effect/Schema';
import getPort from 'get-port';
import { beforeEach, vi } from 'vitest';
import { SessionState } from '../../src/dev/session-state';
import { getStickyPort } from '../../src/dev/sticky-port';
import { DevSessions } from '../../src/dev-sessions';
import { makeTestDevSessionsLayer } from '../support/dev-sessions-layer';
import { runTest } from '../support/run-test';
import { makeTempDir } from '../support/temp-dir';

/** The legacy pre-named-ports shape (`{ port: number }`) — used to seed a session as if it were written before this feature existed. */
const LegacyStoredPort = SessionState.slot(S.Struct({ port: S.Number }));

/** The current shape (`{ ports: Record<string, number> }`). */
const StoredPorts = SessionState.slot(
	S.Struct({ ports: S.Record(S.String, S.Number) }),
);

beforeEach(() => {
	vi.mocked(getPort).mockClear();
});

describe('getStickyPort', () => {
	it.effect('persists the resolved port into sess.json on the first call', () =>
		runTest(
			Effect.gen(function* () {
				vi.mocked(getPort).mockResolvedValueOnce(5555);
				const rootDir = yield* makeTempDir;
				const devSessions = yield* DevSessions.pipe(
					Effect.provide(makeTestDevSessionsLayer(rootDir)),
				);
				const session = yield* devSessions.createSession;

				const port = yield* getStickyPort(session);

				expect(port).toBe(5555);
				expect(yield* StoredPorts.read(session)).toEqual({
					ports: { default: 5555 },
				});
			}),
		),
	);

	it.effect('reuses the remembered port as the preferred choice', () =>
		runTest(
			Effect.gen(function* () {
				vi.mocked(getPort).mockResolvedValueOnce(4000);
				const rootDir = yield* makeTempDir;
				const devSessions = yield* DevSessions.pipe(
					Effect.provide(makeTestDevSessionsLayer(rootDir)),
				);
				const session = yield* devSessions.createSession;

				yield* getStickyPort(session);

				vi.mocked(getPort).mockClear();
				vi.mocked(getPort).mockResolvedValueOnce(4000);
				const second = yield* getStickyPort(session);

				expect(second).toBe(4000);
				expect(getPort).toHaveBeenCalledWith({ port: [4000] });
			}),
		),
	);

	it.effect(
		'returns a different port rather than failing when the remembered one is unavailable',
		() =>
			runTest(
				Effect.gen(function* () {
					vi.mocked(getPort).mockResolvedValueOnce(3000);
					const rootDir = yield* makeTempDir;
					const devSessions = yield* DevSessions.pipe(
						Effect.provide(makeTestDevSessionsLayer(rootDir)),
					);
					const session = yield* devSessions.createSession;

					yield* getStickyPort(session);

					// Simulate get-port falling back because the preferred port is taken.
					vi.mocked(getPort).mockResolvedValueOnce(3001);
					const second = yield* getStickyPort(session);

					expect(second).toBe(3001);
					expect(getPort).toHaveBeenLastCalledWith({ port: [3000] });
				}),
			),
	);

	it.effect('is not cached: two calls in one run both consult get-port', () =>
		runTest(
			Effect.gen(function* () {
				vi.mocked(getPort)
					.mockResolvedValueOnce(6000)
					.mockResolvedValueOnce(6000);
				const rootDir = yield* makeTempDir;
				const devSessions = yield* DevSessions.pipe(
					Effect.provide(makeTestDevSessionsLayer(rootDir)),
				);
				const session = yield* devSessions.createSession;

				yield* getStickyPort(session);
				yield* getStickyPort(session);

				expect(getPort).toHaveBeenCalledTimes(2);
			}),
		),
	);

	it.effect('remembers independent ports for two different names', () =>
		runTest(
			Effect.gen(function* () {
				vi.mocked(getPort)
					.mockResolvedValueOnce(5000)
					.mockResolvedValueOnce(5001);
				const rootDir = yield* makeTempDir;
				const devSessions = yield* DevSessions.pipe(
					Effect.provide(makeTestDevSessionsLayer(rootDir)),
				);
				const session = yield* devSessions.createSession;

				const webPort = yield* getStickyPort(session, { name: 'web' });
				const apiPort = yield* getStickyPort(session, { name: 'api' });

				expect(webPort).toBe(5000);
				expect(apiPort).toBe(5001);
				expect(yield* StoredPorts.read(session)).toEqual({
					ports: { web: 5000, api: 5001 },
				});
			}),
		),
	);

	it.effect(
		"resolving a new name does not clobber a previously stored name's entry",
		() =>
			runTest(
				Effect.gen(function* () {
					vi.mocked(getPort).mockResolvedValueOnce(4400);
					const rootDir = yield* makeTempDir;
					const devSessions = yield* DevSessions.pipe(
						Effect.provide(makeTestDevSessionsLayer(rootDir)),
					);
					const session = yield* devSessions.createSession;

					yield* getStickyPort(session, { name: 'web' });

					vi.mocked(getPort).mockClear();
					vi.mocked(getPort).mockResolvedValueOnce(4401);
					yield* getStickyPort(session, { name: 'api' });

					expect(yield* StoredPorts.read(session)).toEqual({
						ports: { web: 4400, api: 4401 },
					});
				}),
			),
	);

	it.effect('excludes sibling remembered ports when resolving a name', () =>
		runTest(
			Effect.gen(function* () {
				vi.mocked(getPort).mockResolvedValueOnce(4700);
				const rootDir = yield* makeTempDir;
				const devSessions = yield* DevSessions.pipe(
					Effect.provide(makeTestDevSessionsLayer(rootDir)),
				);
				const session = yield* devSessions.createSession;

				yield* getStickyPort(session, { name: 'web' });

				vi.mocked(getPort).mockClear();
				vi.mocked(getPort).mockResolvedValueOnce(4701);
				yield* getStickyPort(session, { name: 'api' });

				expect(getPort).toHaveBeenCalledWith({
					port: undefined,
					exclude: [4700],
				});
			}),
		),
	);

	it.effect('seeds the default name from a legacy top-level `port` key', () =>
		runTest(
			Effect.gen(function* () {
				const rootDir = yield* makeTempDir;
				const devSessions = yield* DevSessions.pipe(
					Effect.provide(makeTestDevSessionsLayer(rootDir)),
				);
				const session = yield* devSessions.createSession;

				// Simulate a sess.json written before named ports existed.
				yield* LegacyStoredPort.write(session, { port: 4999 });

				vi.mocked(getPort).mockResolvedValueOnce(4999);
				const port = yield* getStickyPort(session);

				expect(port).toBe(4999);
				expect(getPort).toHaveBeenCalledWith({ port: [4999] });
			}),
		),
	);
});
