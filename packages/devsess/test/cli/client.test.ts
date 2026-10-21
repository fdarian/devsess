import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync } from 'node:fs';
import { createServer } from 'node:net';
import { join } from 'node:path';
import { describe, expect, it } from '@effect/vitest';
import { Cause, Effect, Exit } from 'effect';
import { callDaemon, DaemonClientError } from '../../src/cli/client';
import { runTest } from '../support/run-test';
import { makeTempDir } from '../support/temp-dir';

const infoRequest = () =>
	({
		version: 1,
		requestId: crypto.randomUUID(),
		method: 'info',
		params: {},
	}) as const;

const failureOf = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
	Effect.gen(function* () {
		const exit = yield* Effect.exit(effect);
		if (Exit.isSuccess(exit)) throw new Error('Expected the call to fail');
		return Cause.squash(exit.cause);
	});

describe('daemon client connect failures', () => {
	it.live('a missing socket means the daemon is not running', () =>
		runTest(
			Effect.gen(function* () {
				const directory = yield* makeTempDir;
				const error = yield* failureOf(
					callDaemon(join(directory, 'missing.sock'), infoRequest()),
				);
				expect(error).toBeInstanceOf(DaemonClientError);
				expect((error as DaemonClientError).kind).toBe('unreachable');
			}),
		),
	);

	it.live(
		'a socket file left behind by a dead daemon means it is not running',
		() =>
			runTest(
				Effect.gen(function* () {
					const directory = yield* makeTempDir;
					const socketPath = join(directory, 'stale.sock');
					// SIGKILL skips the unlink that a clean close performs, leaving the stale file.
					spawnSync(process.execPath, [
						'-e',
						`require('node:net').createServer().listen(${JSON.stringify(socketPath)}, () => process.kill(process.pid, 'SIGKILL'))`,
					]);
					expect(existsSync(socketPath)).toBe(true);
					const error = yield* failureOf(callDaemon(socketPath, infoRequest()));
					expect((error as DaemonClientError).kind).toBe('unreachable');
				}),
			),
	);

	it.live.skipIf(process.getuid?.() === 0)(
		'EACCES is reported with its errno instead of as a missing daemon',
		() =>
			runTest(
				Effect.scoped(
					Effect.gen(function* () {
						const directory = yield* makeTempDir;
						const socketPath = join(directory, 'denied.sock');
						const server = createServer();
						yield* Effect.promise(
							() =>
								new Promise<void>((resolve) =>
									server.listen(socketPath, resolve),
								),
						);
						yield* Effect.addFinalizer(() => Effect.sync(() => server.close()));
						chmodSync(socketPath, 0o000);
						const error = yield* failureOf(
							callDaemon(socketPath, infoRequest()),
						);
						expect(error).toBeInstanceOf(DaemonClientError);
						const clientError = error as DaemonClientError;
						expect(clientError.kind).toBe('connect-failed');
						expect(clientError.code).toBe('EACCES');
						expect(clientError.message).toBe(
							`Could not connect to daemon at ${socketPath}: EACCES`,
						);
					}),
				),
			),
	);
});
