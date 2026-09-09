import { existsSync, readFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { join } from 'node:path';
import { describe, expect, it } from '@effect/vitest';
import { Cause, Effect, Option } from 'effect';
import {
	awaitDaemonHandshake,
	DaemonBootstrapError,
	launchDetachedDaemon,
} from '../../src/cli/bootstrap';
import { runTest } from '../support/run-test';
import { makeTempDir } from '../support/temp-dir';

const waitUntil = (predicate: () => boolean) =>
	Effect.gen(function* () {
		while (!predicate()) {
			yield* Effect.sleep('20 millis');
		}
	}).pipe(Effect.timeout('5 seconds'));

const listen = (server: ReturnType<typeof createServer>, socketPath: string) =>
	Effect.tryPromise({
		try: () =>
			new Promise<void>((resolve, reject) => {
				server.once('error', reject);
				server.listen(socketPath, resolve);
			}),
		catch: (cause) => cause,
	});

describe('daemon bootstrap', () => {
	it.live('waits for the daemon handshake', () =>
		runTest(
			Effect.scoped(
				Effect.gen(function* () {
					const rootDir = yield* makeTempDir;
					const socketPath = join(rootDir, 'daemon.sock');
					const server = createServer((socket) => {
						socket.once('data', (data) => {
							expect(data.toString()).toBe('devsess/handshake\n');
							socket.end('devsess/ready\n');
						});
					});
					yield* listen(server, socketPath);
					yield* Effect.addFinalizer(() => Effect.sync(() => server.close()));

					yield* awaitDaemonHandshake({ socketPath, timeoutMs: 500 });
				}),
			),
		),
	);

	it.live('fails when a daemon does not acknowledge within the bound', () =>
		runTest(
			Effect.scoped(
				Effect.gen(function* () {
					const rootDir = yield* makeTempDir;
					const socketPath = join(rootDir, 'daemon.sock');
					const server = createServer(() => undefined);
					yield* listen(server, socketPath);
					yield* Effect.addFinalizer(() => Effect.sync(() => server.close()));

					const exit = yield* Effect.exit(
						awaitDaemonHandshake({ socketPath, timeoutMs: 50 }),
					);
					expect(exit._tag).toBe('Failure');
					if (exit._tag === 'Failure') {
						const error = Cause.findErrorOption(exit.cause);
						expect(Option.isSome(error)).toBe(true);
						if (Option.isSome(error)) {
							expect(error.value).toBeInstanceOf(DaemonBootstrapError);
						}
					}
				}),
			),
		),
	);

	it.live(
		'leaves a detached daemon alive after the launcher scope closes',
		() =>
			runTest(
				Effect.gen(function* () {
					const rootDir = yield* makeTempDir;
					const pidPath = join(rootDir, 'daemon.pid');
					const donePath = join(rootDir, 'daemon.done');
					const launcher = yield* Effect.scoped(
						launchDetachedDaemon({
							command: process.execPath,
							args: [
								'-e',
								`require('fs').writeFileSync(${JSON.stringify(pidPath)}, String(process.pid)); setTimeout(() => require('fs').writeFileSync(${JSON.stringify(donePath)}, 'done'), 100);`,
							],
						}),
					);
					expect(launcher).toBeGreaterThan(0);
					yield* waitUntil(() => existsSync(donePath));
					expect(readFileSync(pidPath, 'utf8')).toBe(String(launcher));
				}),
			),
	);
});
