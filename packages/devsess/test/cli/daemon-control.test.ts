import { type ChildProcess, spawn } from 'node:child_process';
import { createConnection } from 'node:net';
import { join } from 'node:path';
import { describe, expect, it } from '@effect/vitest';
import { Effect } from 'effect';
import { stopOutdatedDaemon } from '../../src/cli/commands/daemon-control';
import { Processes } from '../../src/cli/processes';
import type { RunRecord } from '../../src/cli/registry';
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
});
