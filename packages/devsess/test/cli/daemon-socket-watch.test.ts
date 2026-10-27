import { type ChildProcess, spawn } from 'node:child_process';
import { existsSync, renameSync, statSync, unlinkSync } from 'node:fs';
import { createConnection, createServer, type Server } from 'node:net';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from '@effect/vitest';
import { Effect, Layer } from 'effect';
import { Daemon, makeDaemon } from '../../src/cli/daemon';
import { Logs } from '../../src/cli/logs';
import { Processes } from '../../src/cli/processes';
import { Registry } from '../../src/cli/registry';
import { runTest } from '../support/run-test';
import { makeTempDir } from '../support/temp-dir';

const cliPath = fileURLToPath(new URL('../../dist/cli.js', import.meta.url));

const layer = (
	directory: string,
	socketPath: string,
	socketWatchIntervalMs: number,
) =>
	Layer.effect(
		Daemon,
		makeDaemon({ dataDirectory: directory, socketPath, socketWatchIntervalMs }),
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

const infoFrame = (requestId: string) =>
	`${JSON.stringify({ version: 1, requestId, method: 'info', params: {} })}\n`;

type Client = {
	readonly request: (requestId: string) => Promise<unknown>;
	readonly close: () => void;
};

const connectClient = (socketPath: string) =>
	new Promise<Client>((resolve, reject) => {
		const socket = createConnection(socketPath);
		const waiting = new Map<string, (frame: unknown) => void>();
		let received = '';
		socket.setEncoding('utf8');
		socket.once('error', reject);
		socket.on('data', (chunk: string) => {
			received += chunk;
			for (
				let newline = received.indexOf('\n');
				newline >= 0;
				newline = received.indexOf('\n')
			) {
				const frame = JSON.parse(received.slice(0, newline));
				received = received.slice(newline + 1);
				waiting.get(frame.requestId)?.(frame);
			}
		});
		socket.once('connect', () =>
			resolve({
				request: (requestId) =>
					new Promise((answered) => {
						waiting.set(requestId, answered);
						socket.write(infoFrame(requestId));
					}),
				close: () => socket.destroy(),
			}),
		);
	});

const retryConnect = async (socketPath: string, timeoutMs: number) => {
	const deadline = Date.now() + timeoutMs;
	while (true) {
		try {
			return await connectClient(socketPath);
		} catch (cause) {
			if (Date.now() > deadline) throw cause;
			await new Promise((resolve) => setTimeout(resolve, 25));
		}
	}
};

const listenForeign = (foreignPath: string) =>
	Effect.gen(function* () {
		const foreign: Server = createServer();
		yield* Effect.promise(
			() =>
				new Promise<void>((resolve) => foreign.listen(foreignPath, resolve)),
		);
		yield* Effect.addFinalizer(() => Effect.sync(() => foreign.close()));
		return foreign;
	});

const inode = (path: string) => statSync(path, { bigint: true }).ino;

describe('daemon socket watchdog', () => {
	it.live(
		're-binds a socket whose file was unlinked and keeps existing clients',
		() =>
			runTest(
				Effect.scoped(
					Effect.gen(function* () {
						const directory = yield* makeTempDir;
						const socketPath = join(directory, 'daemon.sock');
						yield* Effect.gen(function* () {
							yield* Daemon;
							const early = yield* Effect.promise(() =>
								connectClient(socketPath),
							);
							yield* Effect.addFinalizer(() => Effect.sync(early.close));
							const originalInode = inode(socketPath);
							unlinkSync(socketPath);
							const late = yield* Effect.promise(() =>
								retryConnect(socketPath, 5_000),
							);
							yield* Effect.addFinalizer(() => Effect.sync(late.close));
							expect(
								yield* Effect.promise(() => late.request('late')),
							).toMatchObject({
								ok: true,
								requestId: 'late',
							});
							expect(
								yield* Effect.promise(() => early.request('early')),
							).toMatchObject({
								ok: true,
								requestId: 'early',
							});
							expect(inode(socketPath)).not.toBe(originalInode);
						}).pipe(Effect.provide(layer(directory, socketPath, 50)));
						expect(existsSync(socketPath)).toBe(false);
					}),
				),
			),
	);

	it.live(
		'shuts down without unlinking when another process owns the path',
		() =>
			runTest(
				Effect.scoped(
					Effect.gen(function* () {
						const directory = yield* makeTempDir;
						const socketPath = join(directory, 'daemon.sock');
						const foreignPath = join(directory, 'foreign.sock');
						const foreign = yield* listenForeign(foreignPath);
						const foreignInode = inode(foreignPath);
						yield* Effect.gen(function* () {
							const daemon = yield* Daemon;
							renameSync(foreignPath, socketPath);
							yield* daemon.awaitShutdown.pipe(Effect.timeout('5 seconds'));
						}).pipe(Effect.provide(layer(directory, socketPath, 50)));
						expect(inode(socketPath)).toBe(foreignInode);
						expect(foreign.listening).toBe(true);
						const client = yield* Effect.promise(() =>
							connectClient(socketPath).then(
								(c) => c,
								() => undefined,
							),
						);
						// The foreign server does not speak the protocol, but it must still accept.
						expect(client).toBeDefined();
						client?.close();
					}),
				),
			),
	);

	it.live('shutdown leaves a path whose identity changed alone', () =>
		runTest(
			Effect.scoped(
				Effect.gen(function* () {
					const directory = yield* makeTempDir;
					const socketPath = join(directory, 'daemon.sock');
					const foreignPath = join(directory, 'foreign.sock');
					yield* listenForeign(foreignPath);
					const foreignInode = inode(foreignPath);
					yield* Effect.gen(function* () {
						yield* Daemon;
						renameSync(foreignPath, socketPath);
					}).pipe(Effect.provide(layer(directory, socketPath, 60_000)));
					expect(inode(socketPath)).toBe(foreignInode);
				}),
			),
		),
	);

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

	it.live(
		'a spawned daemon exits 0 and leaves a foreign socket in place',
		() =>
			runTest(
				Effect.scoped(
					Effect.gen(function* () {
						const directory = yield* makeTempDir;
						const socketPath = join(directory, 'daemon.sock');
						const foreignPath = join(directory, 'foreign.sock');
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
						const reachable = yield* Effect.promise(() =>
							retryConnect(socketPath, 10_000),
						);
						reachable.close();
						yield* listenForeign(foreignPath);
						const foreignInode = inode(foreignPath);
						renameSync(foreignPath, socketPath);
						expect(
							yield* awaitExit(child).pipe(Effect.timeout('8 seconds')),
						).toEqual({ code: 0, signal: null });
						expect(inode(socketPath)).toBe(foreignInode);
					}),
				),
			),
		15_000,
	);
});
