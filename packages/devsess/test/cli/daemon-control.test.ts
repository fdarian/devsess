import { type ChildProcess, spawn } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { createConnection, createServer } from 'node:net';
import { join } from 'node:path';
import { describe, expect, it } from '@effect/vitest';
import { Cause, ConfigProvider, Effect, Exit } from 'effect';
import { vi } from 'vitest';
import {
	restart,
	status,
	stop,
	stopOutdatedDaemon,
	stopUnresponsiveDaemon,
} from '../../src/cli/commands/daemon-control';
import { Processes } from '../../src/cli/processes';
import type { RunRecord } from '../../src/cli/registry';
import { processBirthOf } from '../support/process-birth';
import { runTest } from '../support/run-test';
import { makeTempDir } from '../support/temp-dir';

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
				return { socketPath, pidfilePath, child, config };
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
