import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { NodeServices } from '@effect/platform-node';
import { describe, expect, it } from '@effect/vitest';
import type { Duration } from 'effect';
import { Effect, Fiber, Logger } from 'effect';
import { runManagedSubprocess } from '../../src/dev/subprocess';
import { makeTempDir } from '../support/temp-dir';

// These spawn real OS processes, so keep the set small. `stdio: 'inherit'`
// means child output can't be captured through the API — children write to a
// file in a temp dir instead, and we assert on that. Real process timing, so
// `it.live` (real Clock) rather than `it.effect` (TestClock never advances).

const isAlive = (pid: number) => {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
};

const waitUntil = (
	predicate: () => boolean,
	timeout: Duration.Input = '5 seconds',
) =>
	Effect.gen(function* () {
		while (!predicate()) {
			yield* Effect.sleep('20 millis');
		}
	}).pipe(Effect.timeout(timeout));

describe('runManagedSubprocess', () => {
	it.live('kills the child when the scope closes', () =>
		Effect.gen(function* () {
			const rootDir = yield* makeTempDir;
			const pidFile = join(rootDir, 'pid');

			// runManagedSubprocess registers its cleanup against the ambient
			// scope rather than a scope of its own, so forking the bare call and
			// interrupting that fiber wouldn't release anything — the fiber
			// doesn't own the scope. Wrap it in `Effect.scoped` to give this
			// fork its own scope, the same way a caller who wants an
			// independently-closeable subprocess would.
			const fiber = yield* Effect.scoped(
				runManagedSubprocess('node', [
					'-e',
					`require('fs').writeFileSync(${JSON.stringify(pidFile)}, String(process.pid)); setInterval(() => {}, 1000)`,
				]),
			).pipe(Effect.forkChild);

			yield* waitUntil(() => existsAndNonEmpty(pidFile));
			const pid = Number(readFileSync(pidFile, 'utf8'));
			expect(isAlive(pid)).toBe(true);

			yield* Fiber.interrupt(fiber);

			yield* waitUntil(() => !isAlive(pid));
			expect(isAlive(pid)).toBe(false);
		}).pipe(Effect.provide(NodeServices.layer)),
	);

	it.live('resolves to the exit code when the child exits on its own', () =>
		Effect.gen(function* () {
			const code = yield* runManagedSubprocess('node', [
				'-e',
				'process.exit(3)',
			]).pipe(Effect.timeout('5 seconds'));

			expect(code).toBe(3);
		}).pipe(Effect.provide(NodeServices.layer)),
	);

	it.live('merges opts.env over process.env', () =>
		Effect.gen(function* () {
			const rootDir = yield* makeTempDir;
			const outFile = join(rootDir, 'env.json');
			const original = process.env.DEVSESS_TEST_VAR;
			process.env.DEVSESS_TEST_VAR = 'from-process-env';

			try {
				const code = yield* runManagedSubprocess(
					'node',
					[
						'-e',
						`require('fs').writeFileSync(${JSON.stringify(outFile)}, JSON.stringify({ hasPath: typeof process.env.PATH === 'string', override: process.env.DEVSESS_TEST_VAR }))`,
					],
					{ env: { DEVSESS_TEST_VAR: 'from-opts' } },
				).pipe(Effect.timeout('5 seconds'));

				expect(code).toBe(0);
				const written = JSON.parse(readFileSync(outFile, 'utf8')) as {
					hasPath: boolean;
					override: string;
				};
				expect(written.hasPath).toBe(true);
				expect(written.override).toBe('from-opts');
			} finally {
				if (original === undefined) {
					delete process.env.DEVSESS_TEST_VAR;
				} else {
					process.env.DEVSESS_TEST_VAR = original;
				}
			}
		}).pipe(Effect.provide(NodeServices.layer)),
	);

	it.live('logs a failing kill instead of throwing it', () =>
		Effect.gen(function* () {
			const messages: string[] = [];
			const capturingLogger = Logger.make<unknown, void>((options) => {
				messages.push(String(options.message));
			});

			// The child exits on its own, so by the time the scope's release
			// runs and tries to kill it, its process group is already gone —
			// the kill fails, and that failure should be logged, not thrown.
			const code = yield* runManagedSubprocess('node', [
				'-e',
				'process.exit(0)',
			]).pipe(
				Effect.timeout('5 seconds'),
				Effect.provide(Logger.layer([capturingLogger])),
			);

			expect(code).toBe(0);
			expect(
				messages.some((message) => message.includes('failed to stop')),
			).toBe(true);
		}).pipe(Effect.provide(NodeServices.layer)),
	);
});

const existsAndNonEmpty = (path: string) => {
	try {
		return readFileSync(path, 'utf8').length > 0;
	} catch {
		return false;
	}
};
