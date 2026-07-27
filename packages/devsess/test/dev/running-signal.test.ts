import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { describe, expect, it } from '@effect/vitest';
import { Effect, Fiber } from 'effect';
import {
	awaitRunning,
	awaitRunningSignal,
	publishRunning,
	publishRunningSignal,
	resolveSiblingDir,
	runningSignalPath,
} from '../../src/dev/running-signal';
import { makeTestDevSessionsLayer } from '../support/dev-sessions-layer';
import { runTest } from '../support/run-test';
import { makeTempDir } from '../support/temp-dir';

// All of these exercise real fs.watch and real timers, so every test runs
// under `it.live` (the real Clock) rather than `it.effect` (TestClock, which
// never advances on its own and would hang these).

const parseJson = (raw: string) => JSON.parse(raw);

describe('runningSignalPath', () => {
	it('joins the dir with the fixed signal file path', () => {
		expect(runningSignalPath('/tmp/some-dir')).toBe(
			join('/tmp/some-dir', '.data/running.json'),
		);
	});
});

describe('publishRunningSignal', () => {
	it.live(
		'writes the value as JSON atomically and removes it when the scope closes',
		() =>
			runTest(
				Effect.gen(function* () {
					const rootDir = yield* makeTempDir;
					const filePath = runningSignalPath(rootDir);

					yield* Effect.scoped(
						Effect.gen(function* () {
							yield* publishRunningSignal(filePath, { port: 4321 });

							expect(existsSync(filePath)).toBe(true);
							expect(existsSync(`${filePath}.tmp`)).toBe(false);
							expect(JSON.parse(readFileSync(filePath, 'utf8'))).toEqual({
								port: 4321,
							});
						}),
					);

					expect(existsSync(filePath)).toBe(false);
				}),
			),
	);
});

describe('awaitRunningSignal', () => {
	it.live(
		'resolves when the signal was published before watching started',
		() =>
			runTest(
				Effect.gen(function* () {
					const rootDir = yield* makeTempDir;
					const filePath = runningSignalPath(rootDir);

					yield* Effect.scoped(
						Effect.gen(function* () {
							yield* publishRunningSignal(filePath, { ready: true });

							const result = yield* awaitRunningSignal(filePath, {
								parse: parseJson,
							}).pipe(Effect.timeout('2 seconds'));

							expect(result).toEqual({ ready: true });
						}),
					);
				}),
			),
	);

	it.live('resolves once the signal is published after watching begins', () =>
		runTest(
			Effect.gen(function* () {
				const rootDir = yield* makeTempDir;
				const filePath = runningSignalPath(rootDir);

				yield* Effect.scoped(
					Effect.gen(function* () {
						const resultFiber = yield* awaitRunningSignal(filePath, {
							parse: parseJson,
						}).pipe(Effect.timeout('5 seconds'), Effect.forkChild);

						// Give the watcher a moment to attach before the file shows up.
						yield* Effect.sleep('100 millis');

						yield* publishRunningSignal(filePath, { ready: true });

						const result = yield* Fiber.join(resultFiber);
						expect(result).toEqual({ ready: true });
					}),
				);
			}),
		),
	);

	it.live(
		'creates the parent directory when it does not exist yet',
		() =>
			runTest(
				Effect.gen(function* () {
					const rootDir = yield* makeTempDir;
					// A sibling package dir whose dev script has never run, so nothing
					// under it exists yet — this used to crash `fsWatch` synchronously.
					const siblingDir = join(rootDir, 'sibling');
					const filePath = runningSignalPath(siblingDir);
					expect(existsSync(dirname(filePath))).toBe(false);

					yield* Effect.scoped(
						Effect.gen(function* () {
							const resultFiber = yield* awaitRunningSignal(filePath, {
								parse: parseJson,
							}).pipe(Effect.timeout('5 seconds'), Effect.forkChild);

							yield* Effect.sleep('100 millis');

							yield* publishRunningSignal(filePath, { ready: true });

							const result = yield* Fiber.join(resultFiber);
							expect(result).toEqual({ ready: true });
						}),
					);
				}),
			),
		10_000,
	);

	it.live('does not resolve when the signal file cannot be parsed', () =>
		runTest(
			Effect.gen(function* () {
				const rootDir = yield* makeTempDir;
				const filePath = runningSignalPath(rootDir);
				mkdirSync(dirname(filePath), { recursive: true });
				writeFileSync(filePath, 'not json');

				const result = yield* awaitRunningSignal(filePath, {
					parse: parseJson,
				}).pipe(Effect.timeout('300 millis'), Effect.exit);

				expect(result._tag).toBe('Failure');
			}),
		),
	);

	it.live('does not resolve when the signal file cannot be read', () =>
		runTest(
			Effect.gen(function* () {
				const rootDir = yield* makeTempDir;
				const filePath = runningSignalPath(rootDir);
				// A directory at the signal path: `exists` is true, but reading it
				// as a string fails — same "leave it waiting" contract as bad JSON.
				mkdirSync(filePath, { recursive: true });

				const result = yield* awaitRunningSignal(filePath, {
					parse: parseJson,
				}).pipe(Effect.timeout('300 millis'), Effect.exit);

				expect(result._tag).toBe('Failure');
			}),
		),
	);
});

describe('resolveSiblingDir', () => {
	it('resolves a relative spec against fromDir', () => {
		expect(resolveSiblingDir('./sibling', '/tmp/root')).toBe(
			resolve('/tmp/root', './sibling'),
		);
	});

	it('resolves an absolute spec as-is', () => {
		expect(resolveSiblingDir('/abs/path', '/tmp/root')).toBe(
			resolve('/tmp/root', '/abs/path'),
		);
	});

	it('resolves a bare name as an npm package via require.resolve', () => {
		const packageDir = join(import.meta.dirname, '..', '..');

		const result = resolveSiblingDir('effect', packageDir);

		expect(existsSync(join(result, 'package.json'))).toBe(true);
		expect(
			JSON.parse(readFileSync(join(result, 'package.json'), 'utf8')).name,
		).toBe('effect');
	});

	it('throws synchronously (uncaught) for an unresolvable name', () => {
		const packageDir = join(import.meta.dirname, '..', '..');

		expect(() =>
			resolveSiblingDir('devsess-package-that-does-not-exist', packageDir),
		).toThrow();
	});
});

// `publishRunning`/`awaitRunning` are the `DevSessions`-aware free functions the
// Effect-based `RunContext` used to bind (`ctx.publishRunning`/`ctx.awaitRunning`) —
// they derive the signal path from `DevSessions#dir` instead of taking one directly.

describe('publishRunning', () => {
	it.live(
		'writes to <DevSessions.dir>/.data/running.json, not under a session dir',
		() =>
			runTest(
				Effect.gen(function* () {
					const rootDir = yield* makeTempDir;
					const signalPath = join(rootDir, '.data/running.json');

					// Assert inside the scope: `publishRunning`'s `acquireRelease` removes
					// the file the moment the scope closes, same as `publishRunningSignal`.
					yield* Effect.scoped(
						Effect.gen(function* () {
							yield* publishRunning({ pid: 1234 }).pipe(
								Effect.provide(makeTestDevSessionsLayer(rootDir)),
							);

							expect(existsSync(signalPath)).toBe(true);
							expect(JSON.parse(readFileSync(signalPath, 'utf8'))).toEqual({
								pid: 1234,
							});
						}),
					);

					expect(existsSync(signalPath)).toBe(false);
				}),
			),
	);
});

describe('awaitRunning', () => {
	it.live('resolves the signal published by a sibling package', () =>
		runTest(
			Effect.gen(function* () {
				const rootDir = yield* makeTempDir;
				const siblingDir = join(rootDir, 'sibling');

				yield* Effect.scoped(
					Effect.gen(function* () {
						yield* publishRunningSignal(runningSignalPath(siblingDir), {
							ready: true,
						});

						const result = yield* awaitRunning<{ ready: boolean }>(
							'./sibling',
						).pipe(
							Effect.provide(makeTestDevSessionsLayer(rootDir)),
							Effect.timeout('2 seconds'),
						);

						expect(result).toEqual({ ready: true });
					}),
				);
			}),
		),
	);
});
