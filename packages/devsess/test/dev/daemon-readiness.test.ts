import { existsSync, readFileSync } from 'node:fs';
import { createServer, type Server, type Socket } from 'node:net';
import { join } from 'node:path';
import { describe, expect, it } from '@effect/vitest';
import { Effect } from 'effect';
import { afterEach, vi } from 'vitest';
import {
	publishRunning,
	runningSignalPath,
} from '../../src/dev/running-signal';
import { makeTestDevSessionsLayer } from '../support/dev-sessions-layer';
import { runTest } from '../support/run-test';
import { makeTempDir } from '../support/temp-dir';

type ReadinessRequest = {
	readonly version: number;
	readonly requestId: string;
	readonly method: string;
	readonly params: {
		readonly runId: string;
		readonly service: string;
		readonly value?: unknown;
	};
};

const serve = (
	socketPath: string,
	onRequest: (request: ReadinessRequest, socket: Socket) => void,
) =>
	Effect.acquireRelease(
		Effect.tryPromise({
			try: () =>
				new Promise<Server>((resolve, reject) => {
					const server = createServer((socket) => {
						let input = '';
						socket.on('data', (chunk) => {
							input += chunk.toString();
							const boundary = input.indexOf('\n');
							if (boundary === -1) return;
							onRequest(
								JSON.parse(input.slice(0, boundary)) as ReadinessRequest,
								socket,
							);
						});
					});
					server.once('error', reject);
					server.listen(socketPath, () => resolve(server));
				}),
			catch: (cause) => new Error('Could not open test socket', { cause }),
		}),
		(server) =>
			Effect.tryPromise({
				try: () =>
					new Promise<void>((resolve, reject) =>
						server.close((cause) =>
							cause === undefined ? resolve() : reject(cause),
						),
					),
				catch: (cause) => new Error('Could not close test socket', { cause }),
			}).pipe(Effect.orDie),
	);

const serviceEnvironment = (socketPath: string) => {
	vi.stubEnv('DEVSESS_SOCKET', socketPath);
	vi.stubEnv('DEVSESS_RUN_ID', 'run-123');
	vi.stubEnv('DEVSESS_SERVICE', 'web');
};

describe('daemon readiness publishing', () => {
	afterEach(() => {
		vi.unstubAllEnvs();
		vi.restoreAllMocks();
	});

	it.live('preserves the file signal without a service identity', () =>
		runTest(
			Effect.gen(function* () {
				const root = yield* makeTempDir;
				vi.stubEnv('DEVSESS_SOCKET', undefined);
				vi.stubEnv('DEVSESS_RUN_ID', undefined);
				vi.stubEnv('DEVSESS_SERVICE', undefined);
				const stderr = vi.spyOn(process.stderr, 'write');
				yield* Effect.scoped(
					Effect.gen(function* () {
						yield* publishRunning({ ready: true }).pipe(
							Effect.provide(makeTestDevSessionsLayer(root)),
						);
						expect(
							JSON.parse(readFileSync(runningSignalPath(root), 'utf8')),
						).toEqual({ ready: true });
					}),
				);
				expect(existsSync(runningSignalPath(root))).toBe(false);
				expect(stderr).not.toHaveBeenCalled();
			}),
		),
	);

	it.live(
		'sends matching protocol-v1 publish and unpublish requests within the file scope',
		() =>
			runTest(
				Effect.scoped(
					Effect.gen(function* () {
						const root = yield* makeTempDir;
						const socketPath = join(root, 'daemon.sock');
						const requests: Array<ReadinessRequest> = [];
						serviceEnvironment(socketPath);
						yield* serve(socketPath, (request, socket) => {
							requests.push(request);
							socket.end(
								`${JSON.stringify({ version: 1, requestId: request.requestId, ok: true, result: {} })}\n`,
							);
						});
						yield* Effect.scoped(
							Effect.gen(function* () {
								yield* publishRunning({ url: 'http://localhost:5173' }).pipe(
									Effect.provide(makeTestDevSessionsLayer(root)),
								);
								expect(existsSync(runningSignalPath(root))).toBe(true);
								expect(requests.map((request) => request.method)).toEqual([
									'publish',
								]);
							}),
						);
						expect(existsSync(runningSignalPath(root))).toBe(false);
						expect(requests.map((request) => request.method)).toEqual([
							'publish',
							'unpublish',
						]);
						expect(requests[0]).toMatchObject({
							version: 1,
							params: {
								runId: 'run-123',
								service: 'web',
								value: { url: 'http://localhost:5173' },
							},
						});
						expect(requests[1]).toMatchObject({
							version: 1,
							params: { runId: 'run-123', service: 'web' },
						});
						expect(requests[0]?.requestId).not.toBe(requests[1]?.requestId);
					}),
				),
			),
	);

	it.live('silently keeps the file signal when the socket is absent', () =>
		runTest(
			Effect.gen(function* () {
				const root = yield* makeTempDir;
				serviceEnvironment(join(root, 'missing.sock'));
				const stderr = vi.spyOn(process.stderr, 'write');
				const started = Date.now();
				yield* Effect.scoped(
					Effect.gen(function* () {
						yield* publishRunning({ ready: true }).pipe(
							Effect.provide(makeTestDevSessionsLayer(root)),
						);
						expect(existsSync(runningSignalPath(root))).toBe(true);
					}),
				);
				expect(Date.now() - started).toBeLessThan(1000);
				expect(existsSync(runningSignalPath(root))).toBe(false);
				expect(stderr).not.toHaveBeenCalled();
			}),
		),
	);

	it.live(
		'silently times out an unresponsive daemon without unpublishing',
		() =>
			runTest(
				Effect.scoped(
					Effect.gen(function* () {
						const root = yield* makeTempDir;
						const socketPath = join(root, 'daemon.sock');
						const requests: Array<ReadinessRequest> = [];
						serviceEnvironment(socketPath);
						const stderr = vi.spyOn(process.stderr, 'write');
						yield* serve(socketPath, (request) => {
							requests.push(request);
						});
						const started = Date.now();
						yield* Effect.scoped(
							Effect.gen(function* () {
								yield* publishRunning({ ready: true }).pipe(
									Effect.provide(makeTestDevSessionsLayer(root)),
								);
								expect(existsSync(runningSignalPath(root))).toBe(true);
							}),
						);
						expect(Date.now() - started).toBeLessThan(1000);
						expect(requests.map((request) => request.method)).toEqual([
							'publish',
						]);
						expect(stderr).not.toHaveBeenCalled();
					}),
				),
			),
	);

	it.live('silently ignores a daemon that rejects publish', () =>
		runTest(
			Effect.scoped(
				Effect.gen(function* () {
					const root = yield* makeTempDir;
					const socketPath = join(root, 'daemon.sock');
					const requests: Array<ReadinessRequest> = [];
					serviceEnvironment(socketPath);
					const stderr = vi.spyOn(process.stderr, 'write');
					yield* serve(socketPath, (request, socket) => {
						requests.push(request);
						socket.end(
							`${JSON.stringify({ version: 1, requestId: request.requestId, ok: false, error: 'Unknown method publish' })}\n`,
						);
					});
					yield* Effect.scoped(
						Effect.gen(function* () {
							yield* publishRunning({ ready: true }).pipe(
								Effect.provide(makeTestDevSessionsLayer(root)),
							);
							expect(existsSync(runningSignalPath(root))).toBe(true);
						}),
					);
					expect(requests.map((request) => request.method)).toEqual([
						'publish',
					]);
					expect(stderr).not.toHaveBeenCalled();
				}),
			),
		),
	);

	it.live(
		'silently ignores a rejected unpublish after clearing the file signal',
		() =>
			runTest(
				Effect.scoped(
					Effect.gen(function* () {
						const root = yield* makeTempDir;
						const socketPath = join(root, 'daemon.sock');
						const requests: Array<ReadinessRequest> = [];
						serviceEnvironment(socketPath);
						const stderr = vi.spyOn(process.stderr, 'write');
						yield* serve(socketPath, (request, socket) => {
							requests.push(request);
							socket.end(
								`${JSON.stringify({
									version: 1,
									requestId: request.requestId,
									ok: request.method === 'publish',
									error:
										request.method === 'unpublish'
											? 'Unknown method unpublish'
											: undefined,
								})}\n`,
							);
						});
						yield* Effect.scoped(
							Effect.gen(function* () {
								yield* publishRunning({ ready: true }).pipe(
									Effect.provide(makeTestDevSessionsLayer(root)),
								);
								expect(existsSync(runningSignalPath(root))).toBe(true);
							}),
						);
						expect(existsSync(runningSignalPath(root))).toBe(false);
						expect(requests.map((request) => request.method)).toEqual([
							'publish',
							'unpublish',
						]);
						expect(stderr).not.toHaveBeenCalled();
					}),
				),
			),
	);
});
