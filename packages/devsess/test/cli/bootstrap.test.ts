import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { join } from 'node:path';
import { describe, expect, it } from '@effect/vitest';
import { Cause, Effect, Exit, Option } from 'effect';
import {
	awaitDaemonHandshake,
	DaemonBootstrapError,
	ensureDaemon,
	launchDetachedDaemon,
} from '../../src/cli/bootstrap';
import { processBirthOf } from '../support/process-birth';
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
							expect(request.method).toBe('info');
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

	it.live('handshakes without waiting for a slow run-list reconciliation', () =>
		runTest(
			Effect.scoped(
				Effect.gen(function* () {
					const rootDir = yield* makeTempDir;
					const socketPath = join(rootDir, 'daemon.sock');
					const methods: Array<string> = [];
					const server = createServer((socket) => {
						socket.once('data', (data) => {
							const request = JSON.parse(data.toString()) as {
								requestId: string;
								method: string;
							};
							methods.push(request.method);
							if (request.method === 'listRuns') return;
							socket.end(
								`${JSON.stringify({ version: 1, requestId: request.requestId, ok: true, result: {} })}\n`,
							);
						});
					});
					yield* listen(server, socketPath);
					yield* Effect.addFinalizer(() => Effect.sync(() => server.close()));
					yield* awaitDaemonHandshake({ socketPath, timeoutMs: 500 });
					expect(methods).toEqual(['info']);
				}),
			),
		),
	);

	it.live('falls back to listRuns for an older protocol-v1 daemon', () =>
		runTest(
			Effect.scoped(
				Effect.gen(function* () {
					const rootDir = yield* makeTempDir;
					const socketPath = join(rootDir, 'daemon.sock');
					const methods: Array<string> = [];
					const server = createServer((socket) => {
						socket.once('data', (data) => {
							const request = JSON.parse(data.toString()) as {
								requestId: string;
								method: string;
							};
							methods.push(request.method);
							socket.end(
								`${JSON.stringify(
									request.method === 'info'
										? {
												version: 1,
												requestId: request.requestId,
												ok: false,
												error: 'Unknown method info',
											}
										: {
												version: 1,
												requestId: request.requestId,
												ok: true,
												result: [],
											},
								)}\n`,
							);
						});
					});
					yield* listen(server, socketPath);
					yield* Effect.addFinalizer(() => Effect.sync(() => server.close()));
					yield* awaitDaemonHandshake({ socketPath, timeoutMs: 500 });
					expect(methods).toEqual(['info', 'listRuns']);
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

	it.live('uses one deadline across handshake retries', () =>
		runTest(
			Effect.scoped(
				Effect.gen(function* () {
					const rootDir = yield* makeTempDir;
					const socketPath = join(rootDir, 'daemon.sock');
					const server = createServer(() => undefined);
					yield* listen(server, socketPath);
					yield* Effect.addFinalizer(() => Effect.sync(() => server.close()));

					const startedAt = Date.now();
					const exit = yield* Effect.exit(
						awaitDaemonHandshake({ socketPath, timeoutMs: 200 }),
					);

					expect(exit._tag).toBe('Failure');
					expect(Date.now() - startedAt).toBeLessThan(1_000);
				}),
			),
		),
	);

	it.live('appends the daemon stdout and stderr to daemon.log', () =>
		runTest(
			Effect.gen(function* () {
				const rootDir = yield* makeTempDir;
				const logsDirectory = join(rootDir, 'logs');
				const logPath = join(logsDirectory, 'daemon.log');
				for (const run of ['first', 'second'])
					yield* launchDetachedDaemon({
						logsDirectory,
						command: process.execPath,
						args: [
							'-e',
							`console.log('${run} out'); console.error('${run} err');`,
						],
					});
				yield* waitUntil(
					() =>
						existsSync(logPath) &&
						['first out', 'first err', 'second out', 'second err'].every(
							(line) => readFileSync(logPath, 'utf8').includes(line),
						),
				);
			}),
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
							logsDirectory: join(rootDir, 'logs'),
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

	it.live('times out a live launch lock that never opens its socket', () =>
		runTest(
			Effect.gen(function* () {
				const rootDir = yield* makeTempDir;
				const socketPath = join(rootDir, 'daemon.sock');
				const dataDirectory = join(rootDir, 'state');
				const lockDirectory = join(dataDirectory, 'daemon-launch.lock');
				mkdirSync(lockDirectory, { recursive: true, mode: 0o700 });
				writeFileSync(
					join(lockDirectory, 'owner'),
					`${process.pid}\n${processBirthOf(process.pid)}\nheld\n`,
				);
				const startedAt = Date.now();
				const exit = yield* Effect.exit(
					ensureDaemon({
						location: { dataDirectory, socketPath },
						timeoutMs: 200,
						launch: () => Effect.die('launch must not run while lock is held'),
					}),
				);
				expect(Date.now() - startedAt).toBeLessThan(1_000);
				expect(exit._tag).toBe('Failure');
				if (exit._tag === 'Failure') {
					const error = Cause.findErrorOption(exit.cause);
					expect(Option.isSome(error)).toBe(true);
					if (Option.isSome(error)) {
						expect(error.value).toBeInstanceOf(DaemonBootstrapError);
						expect(error.value.message).toContain(
							`launch lock ${lockDirectory}`,
						);
						expect(error.value.message).toContain(`owner PID ${process.pid}`);
						expect(error.value.message).toContain(socketPath);
					}
				}
				expect(existsSync(lockDirectory)).toBe(true);
			}),
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

	describe('an endpoint that accepts and never replies', () => {
		it.live(
			'reports a busy daemon, names its PID, and neither kills nor relaunches it',
			() =>
				runTest(
					Effect.scoped(
						Effect.gen(function* () {
							const rootDir = yield* makeTempDir;
							const socketPath = join(rootDir, 'daemon.sock');
							const server = createServer(() => undefined);
							yield* listen(server, socketPath);
							yield* Effect.addFinalizer(() =>
								Effect.sync(() => server.close()),
							);
							writeFileSync(
								join(rootDir, 'daemon.pid'),
								`${process.pid}\n${processBirthOf(process.pid)}\n`,
							);
							let launches = 0;
							const exit = yield* Effect.exit(
								ensureDaemon({
									location: {
										dataDirectory: join(rootDir, 'state'),
										socketPath,
									},
									launch: () =>
										Effect.sync(() => {
											launches += 1;
										}),
								}),
							);
							const error = Exit.isFailure(exit)
								? Cause.squash(exit.cause)
								: undefined;
							expect(error).toBeInstanceOf(DaemonBootstrapError);
							const message = (error as DaemonBootstrapError).message;
							expect(message).toContain(`PID ${process.pid}`);
							expect(message).toContain('busy or unresponsive');
							expect(message).toContain('devsess daemon restart --force');
							expect(launches).toBe(0);
							expect(server.listening).toBe(true);
							expect(existsSync(join(rootDir, 'daemon.pid'))).toBe(true);
						}),
					),
				),
		);
	});

	describe('an endpoint that accepts and then closes', () => {
		const acceptThenClose = () =>
			createServer((socket) => {
				socket.once('data', () => socket.destroy());
			});
		const respondingServer = () =>
			createServer((socket) => {
				socket.once('data', (data) => {
					const request = JSON.parse(data.toString()) as { requestId: string };
					socket.end(
						`${JSON.stringify({ version: 1, requestId: request.requestId, ok: true, result: [] })}\n`,
					);
				});
			});
		const deadPid = () => {
			const finished = spawnSync(process.execPath, ['-e', '0']);
			if (finished.pid === undefined) throw new Error('Missing child PID');
			return finished.pid;
		};

		for (const scenario of [
			{ name: 'a dead PID', pidfile: () => `${deadPid()}\nps:gone\n` },
			{ name: 'no pidfile', pidfile: () => undefined },
		])
			it.live(`unlinks the socket and relaunches for ${scenario.name}`, () =>
				runTest(
					Effect.scoped(
						Effect.gen(function* () {
							const rootDir = yield* makeTempDir;
							const socketPath = join(rootDir, 'daemon.sock');
							const pidfilePath = join(rootDir, 'daemon.pid');
							const stale = acceptThenClose();
							const replacement = respondingServer();
							yield* listen(stale, socketPath);
							yield* Effect.addFinalizer(() =>
								Effect.sync(() => {
									stale.close();
									replacement.close();
								}),
							);
							const pidfile = scenario.pidfile();
							if (pidfile !== undefined) writeFileSync(pidfilePath, pidfile);
							let launches = 0;
							yield* ensureDaemon({
								location: { dataDirectory: join(rootDir, 'state'), socketPath },
								launch: () =>
									Effect.sync(() => {
										launches += 1;
										replacement.listen(socketPath);
									}),
							});
							expect(launches).toBe(1);
							expect(existsSync(pidfilePath)).toBe(false);
						}),
					),
				),
			);

		it.live('fails naming the PID and --force when that PID is alive', () =>
			runTest(
				Effect.scoped(
					Effect.gen(function* () {
						const rootDir = yield* makeTempDir;
						const socketPath = join(rootDir, 'daemon.sock');
						const server = acceptThenClose();
						yield* listen(server, socketPath);
						yield* Effect.addFinalizer(() => Effect.sync(() => server.close()));
						writeFileSync(
							join(rootDir, 'daemon.pid'),
							`${process.pid}\n${processBirthOf(process.pid)}\n`,
						);
						let launches = 0;
						const exit = yield* Effect.exit(
							ensureDaemon({
								location: { dataDirectory: join(rootDir, 'state'), socketPath },
								launch: () =>
									Effect.sync(() => {
										launches += 1;
									}),
							}),
						);
						expect(launches).toBe(0);
						expect(existsSync(socketPath)).toBe(true);
						const error = Exit.isFailure(exit)
							? Cause.squash(exit.cause)
							: undefined;
						expect(error).toBeInstanceOf(DaemonBootstrapError);
						expect((error as DaemonBootstrapError).message).toContain(
							`PID ${process.pid}`,
						);
						expect((error as DaemonBootstrapError).message).toContain(
							'devsess daemon stop --force',
						);
					}),
				),
			),
		);

		it.live('treats a PID whose process birth differs as dead', () =>
			runTest(
				Effect.scoped(
					Effect.gen(function* () {
						const rootDir = yield* makeTempDir;
						const socketPath = join(rootDir, 'daemon.sock');
						const stale = acceptThenClose();
						const replacement = respondingServer();
						yield* listen(stale, socketPath);
						yield* Effect.addFinalizer(() =>
							Effect.sync(() => {
								stale.close();
								replacement.close();
							}),
						);
						writeFileSync(
							join(rootDir, 'daemon.pid'),
							`${process.pid}\nps:reused\n`,
						);
						yield* ensureDaemon({
							location: { dataDirectory: join(rootDir, 'state'), socketPath },
							launch: () => Effect.sync(() => replacement.listen(socketPath)),
						});
					}),
				),
			),
		);
	});
});
