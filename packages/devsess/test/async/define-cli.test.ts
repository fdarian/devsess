import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from '@effect/vitest';
import { generateSlug } from 'random-word-slugs';
import { afterEach, beforeEach, vi } from 'vitest';
import { defineDevCli } from '../../src/async/define-cli';
import { createDevSessions } from '../../src/async/dev-sessions';
import { unwrapSession } from '../../src/async/session';

/**
 * Unlike `src/dev/run-dev-cli.test.ts`, `run` here is a plain (possibly async) function,
 * not an Effect — so a thrown `expect()` is caught by an ordinary `try`/`catch`, no
 * `Effect.catchCause`-style defect handling needed. The only hazard is the same one: the
 * CLI drives `NodeRuntime.runMain`, which calls `process.exit` on completion, but only when
 * the run ends non-zero or a signal was received. `run` here always resolves (we funnel any
 * thrown/rejected error into `reject` ourselves instead of letting it propagate), so the
 * composed program always succeeds and `runMain` never exits the process.
 */
type AsyncCliRunFn = Parameters<typeof defineDevCli>[0]['run'];
type AsyncRunContext = Parameters<AsyncCliRunFn>[0];
type AsyncRunOpts = Parameters<AsyncCliRunFn>[1];

const invokeAsyncCli = <T>(config: {
	dir: string;
	argv?: string[];
	options?: Parameters<typeof defineDevCli>[0]['options'];
	run: (ctx: AsyncRunContext, opts: AsyncRunOpts) => Promise<T> | T;
}): Promise<T> =>
	new Promise((resolve, reject) => {
		const runCli = defineDevCli({
			name: 'test-cli',
			dir: config.dir,
			options: config.options,
			run: async (ctx, opts) => {
				try {
					resolve(await config.run(ctx, opts));
				} catch (error) {
					reject(error);
				}
			},
		});
		runCli(config.argv ?? []);
	});

// Plain `it`, not `it.effect`, so there's no per-test Scope to hang a
// `makeTempDir` cleanup off of — manage our own temp dirs instead.
let tempDirs: string[] = [];

const makeTempDir = () => {
	const dir = mkdtempSync(join(tmpdir(), 'devsess-async-cli-test-'));
	tempDirs.push(dir);
	return dir;
};

afterEach(() => {
	for (const dir of tempDirs) {
		rmSync(dir, { recursive: true, force: true });
	}
	tempDirs = [];
});

beforeEach(() => {
	vi.mocked(generateSlug).mockClear();
});

const isAlive = (pid: number) => {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
};

const waitUntil = async (
	predicate: () => boolean,
	timeoutMs = 5000,
): Promise<void> => {
	const start = Date.now();
	while (Date.now() - start < timeoutMs) {
		if (predicate()) return;
		await new Promise((resolveDelay) => setTimeout(resolveDelay, 20));
	}
	throw new Error('Timed out waiting for condition');
};

const waitForFile = (filePath: string, timeoutMs = 5000) =>
	waitUntil(() => existsSync(filePath), timeoutMs);

describe('defineDevCli (async)', () => {
	it('ctx.session() resolves to the same underlying session across calls', async () => {
		const rootDir = makeTempDir();

		const [first, second] = await invokeAsyncCli({
			dir: rootDir,
			run: async (ctx) => {
				const a = await ctx.session();
				const b = await ctx.session();
				return [a, b] as const;
			},
		});

		expect(unwrapSession(second)).toBe(unwrapSession(first));
		// `createSession` (and thus `generateSlug`) only runs when the sessions dir
		// is empty — one call proves `getLatestOrCreate` ran once, not twice.
		expect(generateSlug).toHaveBeenCalledTimes(1);
	});

	it('run may return synchronously', async () => {
		const rootDir = makeTempDir();

		const result = await invokeAsyncCli({
			dir: rootDir,
			run: () => 'sync-result',
		});

		expect(result).toBe('sync-result');
	});

	it('run may return a Promise', async () => {
		const rootDir = makeTempDir();

		const result = await invokeAsyncCli({
			dir: rootDir,
			run: async () => {
				await new Promise((resolveDelay) => setTimeout(resolveDelay, 5));
				return 'async-result';
			},
		});

		expect(result).toBe('async-result');
	});

	// `runManagedSubprocess` (src/dev/subprocess.ts) attaches its kill-on-close finalizer
	// to whatever scope is ambient rather than one it creates itself, so it registers
	// against the "process-lifetime" scope the async facade captures (src/async/
	// define-cli.ts:46-58) even though `Effect.runPromiseWith` forks an independent root
	// fiber to run it. That gives a fire-and-forget subprocess two guarantees, both
	// asserted below: it outlives the Promise returned by the call that started it (`run`
	// hasn't ended yet, so the process-lifetime scope can't have closed), and it dies once
	// `run` ends (the scope closes right after, running the finalizer).
	it('a subprocess started via ctx.runManagedSubprocess outlives the returned Promise, then dies when run ends', async () => {
		const rootDir = makeTempDir();
		const pidFile = join(rootDir, 'pid');
		let pid: number | undefined;

		try {
			pid = await invokeAsyncCli({
				dir: rootDir,
				run: async (ctx) => {
					// Fire-and-forget: don't await the subprocess's own exit-code
					// promise — a real dev server never exits on its own either. The
					// kill on run-end (asserted below) makes that promise reject
					// ("interrupted by signal"), which nothing here awaits — swallow
					// it so it doesn't surface as an unhandled rejection.
					ctx
						.runManagedSubprocess(process.execPath, [
							'-e',
							`require('fs').writeFileSync(${JSON.stringify(pidFile)}, String(process.pid)); setInterval(() => {}, 1000)`,
						])
						.catch(() => {});

					await waitForFile(pidFile);
					const childPid = Number(readFileSync(pidFile, 'utf8'));

					// `run` hasn't returned yet, so the CLI-process scope that owns
					// the subprocess can't have closed — it must still be alive.
					expect(isAlive(childPid)).toBe(true);

					return childPid;
				},
			});

			// `invokeAsyncCli` resolves as soon as `run` does, which races the scope
			// closure that happens right after (see the comment above) — poll instead
			// of asserting immediately.
			await waitUntil(() => !isAlive(pid as number));
			expect(isAlive(pid)).toBe(false);
		} finally {
			// Guaranteed reap, pass or fail, so a failed assertion above can never
			// leave an orphaned child (and its `setInterval`) hanging the runner.
			if (pid !== undefined && isAlive(pid)) {
				process.kill(pid, 'SIGKILL');
			}
		}
	});

	it(
		'createDevSessions and the CLI-facade DevSessions agree on the same ' +
			'directory, despite building their layers independently',
		async () => {
			const rootDir = makeTempDir();

			const cliSessionName = await invokeAsyncCli({
				dir: rootDir,
				run: async (ctx) => (await ctx.session()).name,
			});

			const manager = createDevSessions(join(rootDir, '.data/sessions'));
			const reused = await manager.getLatestOrCreate();

			expect(reused.name).toBe(cliSessionName);
		},
	);
});
