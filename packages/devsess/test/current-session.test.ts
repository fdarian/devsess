import { describe, expect, it } from '@effect/vitest';
import { Effect } from 'effect';
import { FileSystem } from 'effect/FileSystem';
import * as cli from 'effect/unstable/cli';
import { generateSlug } from 'random-word-slugs';
import { vi } from 'vitest';
import { CurrentSession } from '../src/current-session';
import { DevSessions } from '../src/dev-sessions';
import {
	makeTestDevSessionsLayer,
	sessionsStorageDir,
} from './support/dev-sessions-layer';
import { runTest } from './support/run-test';
import { makeTempDir } from './support/temp-dir';

describe('CurrentSession.layerOf', () => {
	it.effect(
		'pins an explicit session instead of resolving one via DevSessions',
		() =>
			runTest(
				Effect.gen(function* () {
					const rootDir = yield* makeTempDir;
					const devSessions = yield* DevSessions.pipe(
						Effect.provide(makeTestDevSessionsLayer(rootDir)),
					);
					const pinned = yield* devSessions.createSession;

					const resolved = yield* CurrentSession.pipe(
						Effect.provide(CurrentSession.layerOf(pinned)),
					);

					expect(resolved).toBe(pinned);
				}),
			),
	);
});

describe('CurrentSession.layer', () => {
	it.effect(
		'resolves once via layer memoization when wrapping a single effect',
		() =>
			runTest(
				Effect.gen(function* () {
					vi.mocked(generateSlug).mockClear();
					vi.mocked(generateSlug).mockReturnValueOnce('memo-otter');
					const rootDir = yield* makeTempDir;

					const [first, second] = yield* Effect.gen(function* () {
						const a = yield* CurrentSession;
						const b = yield* CurrentSession;
						return [a, b] as const;
					}).pipe(
						Effect.provide(CurrentSession.layer),
						Effect.provide(DevSessions.layerAt(rootDir)),
					);

					expect(second).toBe(first);
					expect(first.name).toBe('memo-otter');
					expect(generateSlug).toHaveBeenCalledTimes(1);
				}),
			),
	);

	// Regression test for the eager-session bug: bundling `CurrentSession` into
	// `DevSessions.layer`/`layerAt` (provided once around the whole CLI) meant a
	// Layer's build effect ran before `cli.Command.run` even looked at argv, so
	// `--help` created a session. Scoping `CurrentSession.layer` to just the command's
	// own handler effect fixes that — `--help` never reaches it.
	it.effect(
		'a --help invocation never touches the session store when CurrentSession is scoped to the handler',
		() =>
			runTest(
				Effect.gen(function* () {
					vi.mocked(generateSlug).mockClear();
					const rootDir = yield* makeTempDir;
					const fs = yield* FileSystem;

					const command = cli.Command.make('test-cli', {}, () =>
						Effect.gen(function* () {
							// A real handler would read `CurrentSession` here.
							yield* CurrentSession;
						}).pipe(Effect.provide(CurrentSession.layer)),
					);

					const program = cli.Command.runWith(command, {
						version: '0.0.0',
					})(['--help']);

					yield* program.pipe(
						Effect.provide(DevSessions.layerAt(rootDir)),
						Effect.scoped,
					);

					expect(yield* fs.exists(sessionsStorageDir(rootDir))).toBe(false);
					expect(generateSlug).not.toHaveBeenCalled();
				}),
			),
	);
});
