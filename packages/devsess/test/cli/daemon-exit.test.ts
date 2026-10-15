import { type ChildProcess, spawn } from 'node:child_process';
import { createConnection, createServer } from 'node:net';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from '@effect/vitest';
import { Cause, Effect, Exit, Layer } from 'effect';
import { daemonTeardown } from '../../src/cli/commands/daemon';
import { Daemon, makeDaemon } from '../../src/cli/daemon';
import { Logs } from '../../src/cli/logs';
import { Processes } from '../../src/cli/processes';
import { Registry } from '../../src/cli/registry';
import { runTest } from '../support/run-test';
import { makeTempDir } from '../support/temp-dir';

const cliPath = fileURLToPath(new URL('../../dist/cli.js', import.meta.url));

const exitCodeOf = (teardown: (onExit: (code: number) => void) => void) => {
	const codes: Array<number> = [];
	teardown((code) => codes.push(code));
	return codes;
};

describe('daemon exit code', () => {
	it('exits 0 when interrupted by a signal and keeps the default codes otherwise', () => {
		expect(
			exitCodeOf((onExit) => daemonTeardown(Exit.interrupt(1), onExit)),
		).toEqual([0]);
		expect(
			exitCodeOf((onExit) => daemonTeardown(Exit.succeed(1), onExit)),
		).toEqual([0]);
		expect(
			exitCodeOf((onExit) => daemonTeardown(Exit.fail('boom'), onExit)),
		).toEqual([1]);
		expect(
			exitCodeOf((onExit) =>
				daemonTeardown(Exit.failCause(Cause.die('boom')), onExit),
			),
		).toEqual([1]);
	});

	const spawnDaemon = (directory: string) =>
		Effect.gen(function* () {
			const socketPath = join(directory, 'daemon.sock');
			const child = spawn(
				process.execPath,
				[
					cliPath,
					'__daemon',
					'--data-directory',
					join(directory, 'state'),
					'--logs-directory',
					join(directory, 'logs'),
					'--socket-path',
					socketPath,
				],
				{ stdio: 'ignore' },
			);
			yield* Effect.addFinalizer(() =>
				Effect.sync(() => {
					if (child.exitCode === null && child.signalCode === null)
						child.kill('SIGKILL');
				}),
			);
			yield* Effect.tryPromise({
				try: () =>
					new Promise<void>((resolve, reject) => {
						const deadline = Date.now() + 10_000;
						const attempt = () => {
							if (Date.now() > deadline) {
								reject(new Error('daemon socket never became reachable'));
								return;
							}
							const probe = createConnection(socketPath);
							probe.once('connect', () => {
								probe.destroy();
								resolve();
							});
							probe.once('error', () => setTimeout(attempt, 50));
						};
						attempt();
					}),
				catch: (cause) => cause,
			});
			return { child, socketPath };
		});

	const awaitExit = (child: ChildProcess) =>
		Effect.promise(
			() =>
				new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
					(resolve) => {
						if (child.exitCode !== null || child.signalCode !== null) {
							resolve({ code: child.exitCode, signal: child.signalCode });
							return;
						}
						child.once('exit', (code, signal) => resolve({ code, signal }));
					},
				),
		);

	it.live('exits 0 after a shutdown request', () =>
		runTest(
			Effect.scoped(
				Effect.gen(function* () {
					const directory = yield* makeTempDir;
					const daemon = yield* spawnDaemon(directory);
					yield* Effect.promise(
						() =>
							new Promise<void>((resolve) => {
								const socket = createConnection(daemon.socketPath);
								socket.once('connect', () => {
									socket.write(
										`${JSON.stringify({ version: 1, requestId: 'stop', method: 'shutdown', params: {} })}\n`,
									);
								});
								socket.resume();
								socket.once('close', () => resolve());
								socket.on('error', () => resolve());
							}),
					);
					expect(yield* awaitExit(daemon.child)).toEqual({
						code: 0,
						signal: null,
					});
				}),
			),
		),
	);

	it.live('exits 0 after SIGTERM', () =>
		runTest(
			Effect.scoped(
				Effect.gen(function* () {
					const directory = yield* makeTempDir;
					const daemon = yield* spawnDaemon(directory);
					daemon.child.kill('SIGTERM');
					expect(yield* awaitExit(daemon.child)).toEqual({
						code: 0,
						signal: null,
					});
				}),
			),
		),
	);
});

describe('daemon socket takeover', () => {
	const layer = (directory: string, socketPath: string) =>
		Layer.effect(
			Daemon,
			makeDaemon({ dataDirectory: directory, socketPath }),
		).pipe(
			Layer.provideMerge(
				Layer.mergeAll(
					Registry.layer({
						dataDirectory: directory,
						logsDirectory: join(directory, 'logs'),
					}),
					Logs.layer({ dataDirectory: directory, maxBytes: 4096 }),
					Processes.layer,
				),
			),
		);

	it.live('listens over the socket a killed daemon left behind', () =>
		runTest(
			Effect.scoped(
				Effect.gen(function* () {
					const directory = yield* makeTempDir;
					const socketPath = join(directory, 'daemon.sock');
					const crashed = spawn(
						process.execPath,
						[
							'-e',
							`require('node:net').createServer().listen(${JSON.stringify(socketPath)}, () => console.log('ready'))`,
						],
						{ stdio: ['ignore', 'pipe', 'ignore'] },
					);
					yield* Effect.promise(
						() =>
							new Promise<void>((resolve) =>
								crashed.stdout?.once('data', () => resolve()),
							),
					);
					crashed.kill('SIGKILL');
					yield* Effect.promise(
						() => new Promise((resolve) => crashed.once('exit', resolve)),
					);
					yield* Effect.gen(function* () {
						const daemon = yield* Daemon;
						expect(
							yield* daemon.request({
								version: 1,
								requestId: 'info',
								method: 'info',
								params: {},
							}),
						).toMatchObject({ socketPath });
					}).pipe(Effect.provide(layer(directory, socketPath)));
				}),
			),
		),
	);

	it.live('refuses to displace a daemon that still answers', () =>
		runTest(
			Effect.scoped(
				Effect.gen(function* () {
					const directory = yield* makeTempDir;
					const socketPath = join(directory, 'daemon.sock');
					const live = createServer();
					yield* Effect.promise(
						() =>
							new Promise<void>((resolve) => live.listen(socketPath, resolve)),
					);
					yield* Effect.addFinalizer(() => Effect.sync(() => live.close()));
					const exit = yield* Effect.exit(
						Effect.gen(function* () {
							yield* Daemon;
						}).pipe(Effect.provide(layer(directory, socketPath))),
					);
					expect(Exit.isFailure(exit)).toBe(true);
					expect(
						Exit.isFailure(exit) ? Cause.pretty(exit.cause) : '',
					).toContain('Could not listen');
					expect(live.listening).toBe(true);
				}),
			),
		),
	);
});
