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

const StoredPort = SessionState.slot(S.Struct({ port: S.Number }));

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
				expect(yield* StoredPort.read(session)).toEqual({ port: 5555 });
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
});
