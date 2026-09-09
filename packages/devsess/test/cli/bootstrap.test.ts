import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { join } from 'node:path';
import { describe, expect, it } from '@effect/vitest';
import { Cause, Effect, Option } from 'effect';
import {
	awaitDaemonHandshake,
	DaemonBootstrapError,
	ensureDaemon,
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
							const request = JSON.parse(data.toString()) as {
								version: number;
								requestId: string;
								method: string;
							};
							expect(request.version).toBe(1);
							expect(request.method).toBe('listRuns');
							socket.end(
								`${JSON.stringify({ version: 1, requestId: request.requestId, ok: true, result: [] })}\n`,
							);
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

	it.live(
		'launches one daemon when concurrent callers bootstrap the same socket',
		() =>
			runTest(
				Effect.scoped(
					Effect.gen(function* () {
						const rootDir = yield* makeTempDir;
						const socketPath = join(rootDir, 'daemon.sock');
						const dataDirectory = join(rootDir, 'state');
						let launches = 0;
						const server = createServer((socket) => {
							socket.once('data', (data) => {
								const request = JSON.parse(data.toString()) as {
									requestId: string;
								};
								socket.end(
									`${JSON.stringify({ version: 1, requestId: request.requestId, ok: true, result: [] })}\n`,
								);
							});
						});
						yield* Effect.addFinalizer(() => Effect.sync(() => server.close()));
						const options = {
							location: { dataDirectory, socketPath },
							launch: () =>
								Effect.sync(() => {
									launches += 1;
									server.listen(socketPath);
								}),
						};
						yield* Effect.all([ensureDaemon(options), ensureDaemon(options)], {
							concurrency: 'unbounded',
						});
						expect(launches).toBe(1);
					}),
				),
			),
	);

	it.live(
		'recovers a stale launch lock without signalling its recorded PID',
		() =>
			runTest(
				Effect.scoped(
					Effect.gen(function* () {
						const rootDir = yield* makeTempDir;
						const socketPath = join(rootDir, 'daemon.sock');
						const dataDirectory = join(rootDir, 'state');
						const lockDirectory = join(dataDirectory, 'daemon-launch.lock');
						mkdirSync(lockDirectory, { recursive: true, mode: 0o700 });
						writeFileSync(
							join(lockDirectory, 'owner'),
							'999999\nlinux:reused-or-dead\nstale\n',
						);
						const server = createServer((socket) => {
							socket.once('data', (data) => {
								const request = JSON.parse(data.toString()) as {
									requestId: string;
								};
								socket.end(
									`${JSON.stringify({ version: 1, requestId: request.requestId, ok: true, result: [] })}\n`,
								);
							});
						});
						yield* Effect.addFinalizer(() => Effect.sync(() => server.close()));
						yield* ensureDaemon({
							location: { dataDirectory, socketPath },
							launch: () => Effect.sync(() => server.listen(socketPath)),
						});
						expect(existsSync(lockDirectory)).toBe(false);
					}),
				),
			),
	);

	it.live(
		'refuses a malformed launch lock without starting another daemon',
		() =>
			runTest(
				Effect.gen(function* () {
					const rootDir = yield* makeTempDir;
					const socketPath = join(rootDir, 'daemon.sock');
					const dataDirectory = join(rootDir, 'state');
					const lockDirectory = join(dataDirectory, 'daemon-launch.lock');
					mkdirSync(lockDirectory, { recursive: true, mode: 0o700 });
					writeFileSync(join(lockDirectory, 'owner'), 'not-an-owner\n');
					let launches = 0;
					const exit = yield* Effect.exit(
						ensureDaemon({
							location: { dataDirectory, socketPath },
							launch: () =>
								Effect.sync(() => {
									launches += 1;
								}),
						}),
					);
					expect(exit._tag).toBe('Failure');
					expect(launches).toBe(0);
				}),
			),
	);

	it.live(
		'preserves a connected but silent endpoint without a launch lock',
		() =>
			runTest(
				Effect.scoped(
					Effect.gen(function* () {
						const rootDir = yield* makeTempDir;
						const socketPath = join(rootDir, 'daemon.sock');
						const dataDirectory = join(rootDir, 'state');
						let launches = 0;
						const server = createServer(() => undefined);
						yield* listen(server, socketPath);
						yield* Effect.addFinalizer(() => Effect.sync(() => server.close()));
						const exit = yield* Effect.exit(
							ensureDaemon({
								location: { dataDirectory, socketPath },
								launch: () =>
									Effect.sync(() => {
										launches += 1;
									}),
							}),
						);
						expect(exit._tag).toBe('Failure');
						expect(launches).toBe(0);
						expect(server.listening).toBe(true);
					}),
				),
			),
	);
});
