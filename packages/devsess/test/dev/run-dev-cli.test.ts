import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { NodeRuntime, NodeServices } from '@effect/platform-node';
import { describe, expect, it } from '@effect/vitest';
import { Cause, Effect } from 'effect';
import * as cli from 'effect/unstable/cli';
import getPort from 'get-port';
import { generateSlug } from 'random-word-slugs';
import { beforeEach, vi } from 'vitest';
import { defineDevCli } from '../../src/dev/define-cli';
import { makeTempDir } from '../support/temp-dir';

const testPlatform = {
	services: NodeServices.layer,
	runMain: NodeRuntime.runMain,
};

/**
 * `defineDevCli` (built on `runDevCli`, see `src/dev/run-dev-cli.ts`) drives
 * `NodeRuntime.runMain`, which calls `process.exit` on completion — but only when the run
 * ends non-zero or a signal was received (`Runtime.makeRunMain` in
 * `@effect/platform-node-shared`: the teardown callback only exits
 * `if (receivedSignal || code !== 0)`). So invoking the returned `(argv) => void` directly
 * in-process is safe as long as the composed program always succeeds.
 *
 * The catch: a failed `expect()` inside `run` throws synchronously inside the Effect
 * generator, which Effect treats as a defect rather than a typed failure — plain
 * `Effect.catch` would NOT intercept that, letting it bubble up as a non-zero exit and
 * kill the vitest worker (vitest stubs `process.exit` to throw instead of actually
 * terminating, but we still shouldn't rely on that safety net). `Effect.catchCause`
 * catches defects too, so every outcome of `run` (success, typed failure, or a thrown
 * assertion) is funneled into resolving or rejecting `invokeCli`'s promise while the CLI's
 * own effect always completes successfully.
 */
type CliRunFn = Parameters<typeof defineDevCli>[0]['run'];
type CliRunContext = Parameters<CliRunFn>[0];
type CliRunOpts = Parameters<CliRunFn>[1];
type CliRunServices = Effect.Services<ReturnType<CliRunFn>>;

const invokeCli = <T>(config: {
	dir: string;
	argv?: string[];
	options?: Parameters<typeof defineDevCli>[0]['options'];
	run: (
		ctx: CliRunContext,
		opts: CliRunOpts,
	) => Effect.Effect<T, unknown, CliRunServices>;
}): Promise<T> =>
	new Promise((resolve, reject) => {
		const runCli = defineDevCli({
			name: 'test-cli',
			dir: config.dir,
			options: config.options,
			platform: testPlatform,
			run: (ctx, opts) =>
				config.run(ctx, opts).pipe(
					Effect.tap((result) => Effect.sync(() => resolve(result))),
					Effect.asVoid,
					Effect.catchCause((cause) =>
						Effect.sync(() => {
							reject(Cause.squash(cause));
						}),
					),
				),
		});
		runCli(config.argv ?? []);
	});

beforeEach(() => {
	vi.mocked(generateSlug).mockClear();
	vi.mocked(getPort).mockClear();
});

describe('defineDevCli', () => {
	it.effect('passes parsed CLI options through to `run`', () =>
		Effect.gen(function* () {
			const rootDir = yield* makeTempDir;

			const opts = yield* Effect.promise(() =>
				invokeCli({
					dir: rootDir,
					argv: ['--port', '4321'],
					options: { port: cli.Flag.integer('port') },
					run: (_ctx, opts) => Effect.succeed(opts),
				}),
			);

			expect(opts).toEqual({ port: 4321 });
		}),
	);

	it.effect('creates a session directory under <dir>/.data/sessions', () =>
		Effect.gen(function* () {
			const rootDir = yield* makeTempDir;

			yield* Effect.promise(() =>
				invokeCli({
					dir: rootDir,
					run: (ctx) => ctx.session,
				}),
			);

			const entries = readdirSync(join(rootDir, '.data/sessions'));
			expect(entries.length).toBe(1);
		}),
	);

	it.effect(
		'caches ctx.session: resolving it twice yields the identical value with a single getLatestOrCreate call',
		() =>
			Effect.gen(function* () {
				const rootDir = yield* makeTempDir;

				const [first, second] = yield* Effect.promise(() =>
					invokeCli({
						dir: rootDir,
						run: (ctx) =>
							Effect.gen(function* () {
								const a = yield* ctx.session;
								const b = yield* ctx.session;
								return [a, b] as const;
							}),
					}),
				);

				expect(second).toBe(first);
				// `createSession` (and thus `generateSlug`) only runs when the sessions
				// dir is empty (see `DevSessions#getLatestOrCreate`), so one call proves
				// the underlying effect ran once, not twice.
				expect(generateSlug).toHaveBeenCalledTimes(1);
			}),
	);

	it.effect(
		'does not cache ctx.getStickyPort: each call re-resolves the port',
		() =>
			Effect.gen(function* () {
				vi.mocked(getPort).mockResolvedValue(5000);
				const rootDir = yield* makeTempDir;

				yield* Effect.promise(() =>
					invokeCli({
						dir: rootDir,
						run: (ctx) =>
							Effect.gen(function* () {
								yield* ctx.getStickyPort();
								yield* ctx.getStickyPort();
							}),
					}),
				);

				expect(getPort).toHaveBeenCalledTimes(2);
			}),
	);

	it.effect(
		'ctx.publishRunning writes to <dir>/.data/running.json, not under the session dir',
		() =>
			Effect.gen(function* () {
				const rootDir = yield* makeTempDir;

				yield* Effect.promise(() =>
					invokeCli({
						dir: rootDir,
						run: (ctx) =>
							Effect.gen(function* () {
								// Force a session into existence first, so we can positively
								// confirm the signal file is project-scoped rather than nested
								// under it.
								yield* ctx.session;
								yield* ctx.publishRunning({ pid: 1234 });
							}),
					}),
				);

				const signalPath = join(rootDir, '.data/running.json');
				expect(existsSync(signalPath)).toBe(true);
				expect(JSON.parse(readFileSync(signalPath, 'utf8'))).toEqual({
					pid: 1234,
				});

				const sessionEntries = readdirSync(join(rootDir, '.data/sessions'));
				for (const name of sessionEntries) {
					expect(
						existsSync(join(rootDir, '.data/sessions', name, 'running.json')),
					).toBe(false);
				}
			}),
	);

	it('--version reports the hardcoded 0.0.0, not the package version', async () => {
		const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
		try {
			const runCli = defineDevCli({
				name: 'test-cli',
				dir: '/tmp/devsess-test-version-unused',
				platform: testPlatform,
				run: () => Effect.void,
			});
			runCli(['--version']);

			await vi.waitFor(() => {
				expect(logSpy).toHaveBeenCalled();
			});

			const logged = logSpy.mock.calls.flat().join('\n');
			expect(logged).toContain('0.0.0');
		} finally {
			logSpy.mockRestore();
		}
	});
});
