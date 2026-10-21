import { type ChildProcess, spawn } from 'node:child_process';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { createConnection, createServer } from 'node:net';
import { join } from 'node:path';
import type { NodeServices } from '@effect/platform-node';
import { describe, expect, it } from '@effect/vitest';
import { Cause, ConfigProvider, Effect, Exit } from 'effect';
import { vi } from 'vitest';
import {
	install,
	restart,
	status,
	stop,
	stopOutdatedDaemon,
	stopUnresponsiveDaemon,
	uninstall,
} from '../../src/cli/commands/daemon-control';
import { DAEMON_LAUNCHD_LABEL, type Launchctl } from '../../src/cli/launchd';
import { Processes } from '../../src/cli/processes';
import type { RunRecord } from '../../src/cli/registry';
import { makeFakeLaunchctl } from '../support/fake-launchctl';
import { processBirthOf } from '../support/process-birth';
import { runTest as runWithPlatform } from '../support/run-test';
import { makeTempDir } from '../support/temp-dir';

/** Every control path takes Launchctl; a fresh fake per test keeps any launchd call away from the real gui domain. */
const runTest = <A, E, R>(
	effect: Effect.Effect<A, E, R | Launchctl | NodeServices.NodeServices>,
) => runWithPlatform(effect.pipe(Effect.provide(makeFakeLaunchctl().layer)));

const staleRun: RunRecord = {
	runId: 'stale-run',
	projectName: 'stale',
	presetName: 'dev',
	canonicalCwd: '/tmp',
	invocationCwd: '/tmp',
	configSnapshot: {},
	startedAt: '2026-09-23T00:00:00.000Z',
	state: 'exited',
	daemon: { pid: 999_999, processGroupId: 999_999, startedAt: 'stale' },
	services: [
		{
			name: 'web',
			command: 'sleep 1',
			cwd: '/tmp',
			state: 'exited',
		},
	],
};

const spawnOutdatedDaemon = (socketPath: string, run: RunRecord) =>
	Effect.try({
		try: () => {
			const source = `
const net = require('node:net');
const socketPath = ${JSON.stringify(socketPath)};
const run = ${JSON.stringify(run)};
const server = net.createServer((socket) => {
  let input = '';
  socket.on('data', (chunk) => {
    input += chunk.toString();
    const boundary = input.indexOf('\\n');
    if (boundary === -1) return;
    const request = JSON.parse(input.slice(0, boundary));
    const response = request.method === 'listRuns'
      ? { version: 1, requestId: request.requestId, ok: true, result: [run] }
      : { version: 1, requestId: request.requestId, ok: false, error: 'Unknown method' };
    socket.end(JSON.stringify(response) + '\\n');
  });
});
server.listen(socketPath);
`;
			const child = spawn(process.execPath, ['-e', source], {
				detached: true,
				stdio: 'ignore',
			});
			if (child.pid === undefined)
				throw new Error('Outdated daemon test process did not receive a PID');
			return child;
		},
		catch: (cause) => cause,
	});

const waitForSocket = (socketPath: string) =>
	Effect.tryPromise({
		try: () =>
			new Promise<void>((resolve, reject) => {
				const deadline = Date.now() + 5_000;
				const attempt = () => {
					if (Date.now() >= deadline) {
						reject(new Error(`Timed out waiting for ${socketPath}`));
						return;
					}
					const socket = createConnection(socketPath);
					let finished = false;
					let timer: NodeJS.Timeout | undefined;
					const retry = () => {
						if (finished) return;
						finished = true;
						if (timer !== undefined) clearTimeout(timer);
						socket.destroy();
						setTimeout(attempt, 25);
					};
					socket.once('connect', () => {
						if (finished) return;
						finished = true;
						if (timer !== undefined) clearTimeout(timer);
						socket.destroy();
						resolve();
					});
					socket.once('error', retry);
					timer = setTimeout(retry, 100);
				};
				attempt();
			}),
		catch: (cause) => cause,
	});

const waitForExit = (child: ChildProcess) =>
	Effect.tryPromise({
		try: () =>
			new Promise<void>((resolve) => {
				if (child.exitCode !== null || child.signalCode !== null) {
					resolve();
					return;
				}
				child.once('exit', () => resolve());
			}),
		catch: (cause) => cause,
	});

describe('daemon control', () => {
	it.live(
		'uses the socket owner instead of a stale persisted daemon identity',
		() =>
			runTest(
				Effect.scoped(
					Effect.gen(function* () {
						const directory = yield* makeTempDir;
						const socketPath = join(directory, 'daemon.sock');
						const child = yield* spawnOutdatedDaemon(socketPath, staleRun);
						yield* Effect.addFinalizer(() =>
							Effect.sync(() => {
								if (
									child.pid !== undefined &&
									child.exitCode === null &&
									child.signalCode === null
								)
									child.kill('SIGKILL');
							}),
						);
						yield* waitForSocket(socketPath);
						yield* stopOutdatedDaemon(socketPath, [staleRun], false).pipe(
							Effect.provide(Processes.layer),
						);
						yield* waitForExit(child);
						expect(child.signalCode).toBe('SIGTERM');
					}),
				),
			),
	);

	describe('an unresponsive daemon', () => {
		/** A child that stays alive until signalled stands in for the hung daemon process. */
		const spawnFakeDaemon = (options: { ignoreSigterm: boolean }) =>
			Effect.acquireRelease(
				Effect.tryPromise({
					try: () =>
						new Promise<ChildProcess>((resolve, reject) => {
							const child = spawn(
								process.execPath,
								[
									'-e',
									`${options.ignoreSigterm ? "process.on('SIGTERM', () => {});" : ''}setInterval(() => {}, 1000); console.log('ready');`,
								],
								{ stdio: ['ignore', 'pipe', 'ignore'] },
							);
							child.once('error', reject);
							child.stdout?.once('data', () => resolve(child));
						}),
					catch: (cause) => cause,
				}),
				(child) =>
					Effect.sync(() => {
						if (child.exitCode === null && child.signalCode === null)
							child.kill('SIGKILL');
					}),
			);

		const setup = (options: { fakeDaemon: boolean; ignoreSigterm?: boolean }) =>
			Effect.gen(function* () {
				const directory = yield* makeTempDir;
				const runtimeDirectory = join(directory, 'r');
				const socketPath = join(runtimeDirectory, 'devsess', 'devsess.sock');
				mkdirSync(join(runtimeDirectory, 'devsess'), { recursive: true });
				const server = createServer((socket) => {
					socket.once('data', () => socket.destroy());
				});
				yield* Effect.addFinalizer(() => Effect.sync(() => server.close()));
				yield* Effect.promise(
					() =>
						new Promise<void>((resolve) => server.listen(socketPath, resolve)),
				);
				const pidfilePath = join(runtimeDirectory, 'devsess', 'devsess.pid');
				const child = options.fakeDaemon
					? yield* spawnFakeDaemon({
							ignoreSigterm: options.ignoreSigterm === true,
						})
					: undefined;
				if (child?.pid !== undefined)
					writeFileSync(
						pidfilePath,
						`${child.pid}\n${processBirthOf(child.pid)}\n`,
					);
				const config = ConfigProvider.fromEnv({
					env: {
						XDG_STATE_HOME: join(directory, 's'),
						XDG_RUNTIME_DIR: runtimeDirectory,
					},
				});
				return { socketPath, pidfilePath, child, config, server };
			});

		const captureStdout = () => {
			const lines: Array<string> = [];
			const spy = vi
				.spyOn(process.stdout, 'write')
				.mockImplementation((chunk) => {
					lines.push(String(chunk));
					return true;
				});
			return { output: () => lines.join(''), restore: () => spy.mockRestore() };
		};

		it.live('stop --force terminates the daemon and clears its endpoint', () =>
			runTest(
				Effect.scoped(
					Effect.gen(function* () {
						const fixture = yield* setup({ fakeDaemon: true });
						const child = fixture.child as ChildProcess;
						const stdout = captureStdout();
						yield* stop(true).pipe(
							Effect.provide(ConfigProvider.layer(fixture.config)),
							Effect.ensuring(Effect.sync(stdout.restore)),
						);
						yield* waitForExit(child);
						expect(child.signalCode).toBe('SIGTERM');
						expect(existsSync(fixture.socketPath)).toBe(false);
						expect(existsSync(fixture.pidfilePath)).toBe(false);
						expect(stdout.output()).toContain(
							`Stopped unresponsive daemon PID ${child.pid}`,
						);
					}),
				),
			),
		);

		it.live('escalates to SIGKILL when the daemon ignores SIGTERM', () =>
			runTest(
				Effect.scoped(
					Effect.gen(function* () {
						const fixture = yield* setup({
							fakeDaemon: true,
							ignoreSigterm: true,
						});
						const child = fixture.child as ChildProcess;
						const stdout = captureStdout();
						yield* stopUnresponsiveDaemon(
							fixture.socketPath,
							child.pid,
							true,
							200,
						).pipe(Effect.ensuring(Effect.sync(stdout.restore)));
						yield* waitForExit(child);
						expect(child.signalCode).toBe('SIGKILL');
						expect(existsSync(fixture.socketPath)).toBe(false);
					}),
				),
			),
		);

		it.live.skipIf(process.platform !== 'darwin')(
			'unloads the launchd job before signalling so KeepAlive cannot resurrect the daemon',
			() =>
				runTest(
					Effect.scoped(
						Effect.gen(function* () {
							const fixture = yield* setup({ fakeDaemon: true });
							const child = fixture.child as ChildProcess;
							const aliveAtBootout: Array<boolean> = [];
							const fake = makeFakeLaunchctl({
								loaded: true,
								onBootout: () =>
									aliveAtBootout.push(
										child.exitCode === null && child.signalCode === null,
									),
							});
							const stdout = captureStdout();
							yield* stopUnresponsiveDaemon(
								fixture.socketPath,
								child.pid,
								true,
							).pipe(
								Effect.provide(fake.layer),
								Effect.provide(
									ConfigProvider.layer(ConfigProvider.fromEnv({ env: {} })),
								),
								Effect.ensuring(Effect.sync(stdout.restore)),
							);
							yield* waitForExit(child);
							expect(aliveAtBootout).toEqual([true]);
							expect(fake.calls).toContain(`bootout ${DAEMON_LAUNCHD_LABEL}`);
							expect(child.signalCode).toBe('SIGTERM');
							expect(stdout.output()).toContain('Unloaded launchd job');
						}),
					),
				),
		);

		it.live('leaves launchd alone when an XDG location is explicit', () =>
			runTest(
				Effect.scoped(
					Effect.gen(function* () {
						const fixture = yield* setup({ fakeDaemon: true });
						const fake = makeFakeLaunchctl({ loaded: true });
						const stdout = captureStdout();
						yield* stop(true).pipe(
							Effect.provide(fake.layer),
							Effect.provide(ConfigProvider.layer(fixture.config)),
							Effect.ensuring(Effect.sync(stdout.restore)),
						);
						expect(fake.calls).toEqual([]);
					}),
				),
			),
		);

		for (const command of [
			{ name: 'install', run: () => install(false) },
			{ name: 'uninstall', run: () => uninstall(false) },
		])
			it.live(`${command.name} refuses when launchd does not apply`, () =>
				runTest(
					Effect.scoped(
						Effect.gen(function* () {
							const fixture = yield* setup({ fakeDaemon: true });
							const child = fixture.child as ChildProcess;
							const fake = makeFakeLaunchctl();
							const exit = yield* Effect.exit(
								command
									.run()
									.pipe(
										Effect.provide(fake.layer),
										Effect.provide(ConfigProvider.layer(fixture.config)),
									),
							);
							expect(Exit.isFailure(exit)).toBe(true);
							expect(
								Exit.isFailure(exit) ? Cause.pretty(exit.cause) : '',
							).toContain('launchd manages the daemon only on macOS');
							expect(fake.calls).toEqual([]);
							expect(child.exitCode).toBeNull();
						}),
					),
				),
			);

		for (const command of [
			{ name: 'stop', run: () => stop(false) },
			{ name: 'restart', run: () => restart(false) },
		])
			it.live(`${command.name} without --force refuses to kill it`, () =>
				runTest(
					Effect.scoped(
						Effect.gen(function* () {
							const fixture = yield* setup({ fakeDaemon: true });
							const child = fixture.child as ChildProcess;
							const exit = yield* Effect.exit(
								command
									.run()
									.pipe(Effect.provide(ConfigProvider.layer(fixture.config))),
							);
							expect(Exit.isFailure(exit)).toBe(true);
							expect(
								Exit.isFailure(exit) ? Cause.pretty(exit.cause) : '',
							).toContain('--force');
							expect(child.exitCode).toBeNull();
							expect(child.signalCode).toBeNull();
							expect(existsSync(fixture.socketPath)).toBe(true);
						}),
					),
				),
			);

		it.live('stop clears a stale socket when no daemon process is left', () =>
			runTest(
				Effect.scoped(
					Effect.gen(function* () {
						const fixture = yield* setup({ fakeDaemon: false });
						const stdout = captureStdout();
						yield* stop(false).pipe(
							Effect.provide(ConfigProvider.layer(fixture.config)),
							Effect.ensuring(Effect.sync(stdout.restore)),
						);
						expect(existsSync(fixture.socketPath)).toBe(false);
						expect(stdout.output()).toContain('Removed stale daemon socket');
					}),
				),
			),
		);

		/** Answers info and listRuns like a live daemon; `shutdown` is what the scenario varies. `closes-socket-then-exits` mimics the real daemon: the socket vanishes first and the process lingers for `exitDelayMs`. */
		const setupResponsive = (
			shutdown: 'fails' | 'acknowledged' | 'closes-socket-then-exits',
			exitDelayMs = 0,
		) =>
			Effect.gen(function* () {
				const fixture = yield* setup({ fakeDaemon: true });
				fixture.server.close();
				const child = fixture.child as ChildProcess;
				const responding = createServer((socket) => {
					let input = '';
					socket.on('data', (chunk) => {
						input += chunk.toString();
						const boundary = input.indexOf('\n');
						if (boundary === -1) return;
						const request = JSON.parse(input.slice(0, boundary)) as {
							requestId: string;
							method: string;
						};
						const reply = (frame: object) =>
							socket.end(
								`${JSON.stringify({ version: 1, requestId: request.requestId, ...frame })}\n`,
							);
						if (request.method === 'info')
							reply({
								ok: true,
								result: {
									pid: child.pid,
									startedAt: new Date().toISOString(),
									executable: process.execPath,
									scriptPath: 'devsess',
									packageVersion: '0.0.0',
									protocolVersion: 1,
									socketPath: fixture.socketPath,
									dataDirectory: '/tmp',
									runCount: 0,
									liveServiceCount: 0,
									attachedClientCount: 0,
								},
							});
						else if (request.method === 'listRuns')
							reply({ ok: true, result: [] });
						else if (shutdown === 'fails')
							reply({ ok: false, error: 'Daemon request queue is closed' });
						else {
							reply({ ok: true, result: {} });
							if (shutdown === 'closes-socket-then-exits') {
								responding.close();
								rmSync(fixture.socketPath, { force: true });
								setTimeout(() => child.kill('SIGKILL'), exitDelayMs);
							}
						}
					});
				});
				rmSync(fixture.socketPath, { force: true });
				yield* Effect.promise(
					() =>
						new Promise<void>((resolve) =>
							responding.listen(fixture.socketPath, resolve),
						),
				);
				yield* Effect.addFinalizer(() => Effect.sync(() => responding.close()));
				return fixture;
			});

		it.live(
			'stop --force terminates the pidfile PID when the shutdown request fails',
			() =>
				runTest(
					Effect.scoped(
						Effect.gen(function* () {
							const fixture = yield* setupResponsive('fails');
							const child = fixture.child as ChildProcess;
							const stdout = captureStdout();
							yield* stop(true).pipe(
								Effect.provide(ConfigProvider.layer(fixture.config)),
								Effect.ensuring(Effect.sync(stdout.restore)),
							);
							yield* waitForExit(child);
							expect(child.signalCode).toBe('SIGTERM');
							expect(existsSync(fixture.socketPath)).toBe(false);
							expect(existsSync(fixture.pidfilePath)).toBe(false);
							expect(stdout.output()).toContain('the shutdown request failed');
						}),
					),
				),
		);

		it.live(
			'stop --force terminates the pidfile PID when the daemon outlives its grace period',
			() =>
				runTest(
					Effect.scoped(
						Effect.gen(function* () {
							const fixture = yield* setupResponsive('acknowledged');
							const child = fixture.child as ChildProcess;
							const stdout = captureStdout();
							yield* stop(true, 150).pipe(
								Effect.provide(ConfigProvider.layer(fixture.config)),
								Effect.ensuring(Effect.sync(stdout.restore)),
							);
							yield* waitForExit(child);
							expect(child.signalCode).toBe('SIGTERM');
							expect(stdout.output()).toContain('did not exit within 150ms');
						}),
					),
				),
		);

		it.live(
			'stop without --force reports the failed shutdown and leaves the daemon alone',
			() =>
				runTest(
					Effect.scoped(
						Effect.gen(function* () {
							const fixture = yield* setupResponsive('fails');
							const child = fixture.child as ChildProcess;
							const exit = yield* Effect.exit(
								stop(false).pipe(
									Effect.provide(ConfigProvider.layer(fixture.config)),
								),
							);
							expect(Exit.isFailure(exit)).toBe(true);
							expect(
								Exit.isFailure(exit) ? Cause.pretty(exit.cause) : '',
							).toContain('Could not shut down daemon');
							expect(child.exitCode).toBeNull();
							expect(child.signalCode).toBeNull();
						}),
					),
				),
		);

		it.live(
			'stop --force does not terminate anything without a live pidfile PID',
			() =>
				runTest(
					Effect.scoped(
						Effect.gen(function* () {
							const fixture = yield* setupResponsive('fails');
							const child = fixture.child as ChildProcess;
							rmSync(fixture.pidfilePath);
							const exit = yield* Effect.exit(
								stop(true).pipe(
									Effect.provide(ConfigProvider.layer(fixture.config)),
								),
							);
							expect(Exit.isFailure(exit)).toBe(true);
							expect(
								Exit.isFailure(exit) ? Cause.pretty(exit.cause) : '',
							).toContain('nothing was terminated');
							expect(child.exitCode).toBeNull();
							expect(existsSync(fixture.socketPath)).toBe(true);
						}),
					),
				),
		);

		const isAlive = (pid: number) => {
			try {
				process.kill(pid, 0);
				return true;
			} catch {
				return false;
			}
		};

		it.live(
			'stop reports "stopped" only once the daemon process has exited',
			() =>
				runTest(
					Effect.scoped(
						Effect.gen(function* () {
							const fixture = yield* setupResponsive(
								'closes-socket-then-exits',
								400,
							);
							const child = fixture.child as ChildProcess;
							const pid = child.pid as number;
							const stdout = captureStdout();
							const startedAt = Date.now();
							yield* stop(false, 5_000).pipe(
								Effect.provide(ConfigProvider.layer(fixture.config)),
								Effect.ensuring(Effect.sync(stdout.restore)),
							);
							expect(Date.now() - startedAt).toBeGreaterThanOrEqual(350);
							expect(isAlive(pid)).toBe(false);
							expect(stdout.output()).toContain('Daemon stopped.');
						}),
					),
				),
		);

		for (const command of [
			{ name: 'stop', run: (ms: number) => stop(false, ms) },
			{ name: 'restart', run: (ms: number) => restart(false, ms) },
		])
			it.live(
				`${command.name} fails naming the PID when the process outlives the shutdown budget`,
				() =>
					runTest(
						Effect.scoped(
							Effect.gen(function* () {
								const fixture = yield* setupResponsive(
									'closes-socket-then-exits',
									60_000,
								);
								const child = fixture.child as ChildProcess;
								const stdout = captureStdout();
								const exit = yield* Effect.exit(
									command
										.run(300)
										.pipe(
											Effect.provide(ConfigProvider.layer(fixture.config)),
											Effect.ensuring(Effect.sync(stdout.restore)),
										),
								);
								expect(Exit.isFailure(exit)).toBe(true);
								const message = Exit.isFailure(exit)
									? Cause.pretty(exit.cause)
									: '';
								expect(message).toContain(`Daemon PID ${child.pid}`);
								expect(message).toContain('still shutting down');
								expect(stdout.output()).not.toContain('Daemon stopped.');
								expect(isAlive(child.pid as number)).toBe(true);
							}),
						),
					),
			);

		it.live(
			'stop --force terminates a process that outlives the shutdown budget even after its pidfile is gone',
			() =>
				runTest(
					Effect.scoped(
						Effect.gen(function* () {
							const fixture = yield* setupResponsive(
								'closes-socket-then-exits',
								60_000,
							);
							const child = fixture.child as ChildProcess;
							rmSync(fixture.pidfilePath);
							const stdout = captureStdout();
							yield* stop(true, 300).pipe(
								Effect.provide(ConfigProvider.layer(fixture.config)),
								Effect.ensuring(Effect.sync(stdout.restore)),
							);
							yield* waitForExit(child);
							expect(child.signalCode).toBe('SIGTERM');
							expect(stdout.output()).toContain('was still shutting down');
							expect(stdout.output()).toContain(`terminating PID ${child.pid}`);
						}),
					),
				),
		);

		it.live('status reports it as unresponsive with the PID', () =>
			runTest(
				Effect.scoped(
					Effect.gen(function* () {
						const fixture = yield* setup({ fakeDaemon: true });
						const child = fixture.child as ChildProcess;
						const stdout = captureStdout();
						const exit = yield* Effect.exit(
							status().pipe(
								Effect.provide(ConfigProvider.layer(fixture.config)),
								Effect.ensuring(Effect.sync(stdout.restore)),
							),
						);
						expect(Exit.isFailure(exit)).toBe(true);
						expect(stdout.output()).toContain('Daemon: unresponsive');
						expect(stdout.output()).toContain(`PID: ${child.pid}`);
					}),
				),
			),
		);
	});
});
