import { describe, expect, it } from '@effect/vitest';
import { Effect } from 'effect';
import { generateSlug } from 'random-word-slugs';
import { vi } from 'vitest';
import { DevSessions } from '../src/dev-sessions';
import { makeTestDevSessionsLayer } from './support/dev-sessions-layer';
import { makeTempDir } from './support/temp-dir';

describe('getLatestOrCreate', () => {
	it.effect('creates a session in an empty dir', () =>
		Effect.gen(function* () {
			vi.mocked(generateSlug).mockReturnValueOnce('brave-otter');

			const rootDir = yield* makeTempDir;
			const devSessions = yield* DevSessions.pipe(
				Effect.provide(makeTestDevSessionsLayer(rootDir)),
			);

			const session = yield* devSessions.getLatestOrCreate;

			expect(session.name).toBe('brave-otter');
			expect(session.lastModifiedAt).toBeNull();
		}),
	);

	it.effect('reuses the most recently modified session on a second call', () =>
		Effect.gen(function* () {
			const rootDir = yield* makeTempDir;
			const devSessions = yield* DevSessions.pipe(
				Effect.provide(makeTestDevSessionsLayer(rootDir)),
			);

			const first = yield* devSessions.getLatestOrCreate;
			const second = yield* devSessions.getLatestOrCreate;

			expect(second.name).toBe(first.name);
		}),
	);
});
