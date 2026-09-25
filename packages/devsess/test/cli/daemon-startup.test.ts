import { createConnection, type Socket } from 'node:net';
import { join } from 'node:path';
import { describe, expect, it } from '@effect/vitest';
import { Effect, Layer, Schema } from 'effect';
import { FileSystem } from 'effect/FileSystem';
import { Daemon, makeDaemon } from '../../src/cli/daemon';
import { Logs } from '../../src/cli/logs';
import { Processes } from '../../src/cli/processes';
import { DaemonInfo, type DaemonRequest } from '../../src/cli/protocol';
import { Registry, RunRecordSchema } from '../../src/cli/registry';
import { runTest } from '../support/run-test';
import { makeTempDir } from '../support/temp-dir';

const layer = (directory: string, socketPath: string) => {
	const dependencies = Layer.mergeAll(
		Registry.layer({ dataDirectory: directory }),
		Logs.layer({ dataDirectory: directory, maxBytes: 4096 }),
		Layer.effect(
			Processes,
			Effect.gen(function* () {
				const processes = yield* Processes.make;
				return {
					...processes,
					captureLive: (pid: number) =>
						Effect.sleep('500 millis').pipe(
							Effect.andThen(processes.captureLive(pid)),
						),
				};
			}),
		),
	);
	return Layer.effect(
		Daemon,
		makeDaemon({ dataDirectory: directory, socketPath }),
	).pipe(Layer.provideMerge(dependencies));
};
const start = (
	command: string,
): Extract<DaemonRequest, { readonly method: 'startRun' }> => ({
	version: 1,
	requestId: 'start',
	method: 'startRun',
	params: {
		runId: 'run',
		projectName: 'project',
		presetName: 'dev',
		canonicalCwd: '/tmp',
		invocationCwd: '/tmp',
		configSnapshot: {},
		environment: {},
		services: [{ name: 'web', command, cwd: '/tmp' }],
	},
});
const list: DaemonRequest = {
	version: 1,
	requestId: 'list',
	method: 'listRuns',
	params: {},
};
const info: DaemonRequest = {
	version: 1,
	requestId: 'info',
	method: 'info',
	params: {},
};
const shutdown: DaemonRequest = {
	version: 1,
	requestId: 'shutdown',
	method: 'shutdown',
	params: {},
};
const tail = (socket: Socket, marker: string) =>
	Effect.tryPromise({
		try: () =>
			new Promise<string>((resolve, reject) => {
				let received = '';
				socket.on('error', reject);
				socket.on('data', (chunk) => {
					received += chunk.toString();
					if (
						received.includes(marker) &&
						received.includes('"event":"output"')
					)
						resolve(received);
				});
				socket.write(
					`${JSON.stringify({ version: 1, requestId: 'tail', method: 'tail', params: { runId: 'run', serviceName: 'web' } })}\n`,
				);
			}),
		catch: (cause) => cause,
	}).pipe(Effect.timeout('2 seconds'));

const checkReplay = (marker: string) =>
	Effect.gen(function* () {
		const daemon = yield* Daemon;
		yield* daemon.request(list);
		const logs = yield* Logs;
		const replay = yield* logs.replayAndSubscribe(
			{ runId: 'run', serviceName: 'web' },
			0,
			() => Effect.void,
		);
		yield* replay.unsubscribe;
		expect(replay.replay.map((event) => event.data).join('')).toContain(marker);
	});

describe('real PTY startup events', () => {
	for (const restartCount of [1, 2]) {
		it.live(`stops every process after ${restartCount} restart(s)`, () =>
			runTest(
				Effect.gen(function* () {
					const directory = yield* makeTempDir;
					const socketPath = join(directory, 'daemon.sock');
					yield* Effect.gen(function* () {
						const daemon = yield* Daemon;
						const processes = yield* Processes;
						const original = start('sleep 30 & wait');
						const started = yield* daemon
							.request({
								...original,
								params: {
									...original.params,
									canonicalCwd: directory,
									invocationCwd: directory,
									services: [
										{ name: 'web', command: 'sleep 30 & wait', cwd: directory },
									],
								},
							})
							.pipe(
								Effect.flatMap(Schema.decodeUnknownEffect(RunRecordSchema)),
							);
						const identities = [started.services[0]?.process];
						expect(identities[0]).toBeDefined();
						for (let index = 0; index < restartCount; index++) {
							const restarted = yield* daemon
								.request({
									version: 1,
									requestId: `restart-${index}`,
									method: 'restartServices',
									params: { runId: 'run', serviceNames: ['web'] },
								})
								.pipe(
									Effect.flatMap(Schema.decodeUnknownEffect(RunRecordSchema)),
								);
							const identity = restarted.services[0]?.process;
							expect(identity).toBeDefined();
							expect(identity?.pid).not.toBe(identities.at(-1)?.pid);
							if (identity === undefined)
								return yield* Effect.die('Missing restarted process');
							identities.push(identity);
							expect(yield* processes.groupAlive(identity.processGroupId)).toBe(
								true,
							);
						}
						const stopped = yield* daemon.request({
							version: 1,
							requestId: 'stop',
							method: 'stopRun',
							params: { runId: 'run' },
						});
						expect(stopped).toMatchObject({
							state: 'exited',
							services: [{ state: 'exited' }],
						});
						for (const identity of identities) {
							if (identity !== undefined)
								expect(
									yield* processes.groupAlive(identity.processGroupId),
								).toBe(false);
						}
					}).pipe(Effect.provide(layer(directory, socketPath)));
				}),
			),
		);
	}
	it.live(
		'restarts one service with its original environment, clears readiness, and appends to its log',
		() =>
			runTest(
				Effect.gen(function* () {
					const directory = yield* makeTempDir;
					const socketPath = join(directory, 'daemon.sock');
					yield* Effect.gen(function* () {
						const daemon = yield* Daemon;
						const logs = yield* Logs;
						const original: DaemonRequest = {
							version: 1,
							requestId: 'start',
							method: 'startRun',
							params: {
								runId: 'run',
								projectName: 'project',
								presetName: 'dev',
								canonicalCwd: directory,
								invocationCwd: directory,
								configSnapshot: {},
								environment: { TOKEN: 'original' },
								services: [
									{
										name: 'web',
										command:
											'printf "generation:%s\\n" "$TOKEN"; exec sleep 30',
										cwd: directory,
										awaitPublish: true,
									},
									{ name: 'db', command: 'exec sleep 30', cwd: directory },
								],
							},
						};
						const started = yield* daemon
							.request(original)
							.pipe(
								Effect.flatMap(Schema.decodeUnknownEffect(RunRecordSchema)),
							);
						const fileSystem = yield* FileSystem;
						const persisted = yield* fileSystem.readFileString(
							join(directory, 'running.json'),
						);
						expect(persisted).not.toContain('original');
						expect(persisted).not.toContain('environment');
						const dbPid = started.services.find(
							(service) => service.name === 'db',
						)?.process?.pid;
						expect(dbPid).toBeDefined();
						yield* daemon.request({
							version: 1,
							requestId: 'publish',
							method: 'publish',
							params: { runId: 'run', service: 'web', value: 'ready' },
						});
						const restarted = yield* daemon
							.request({
								version: 1,
								requestId: 'restart',
								method: 'restartServices',
								params: { runId: 'run', serviceNames: ['web'] },
							})
							.pipe(
								Effect.flatMap(Schema.decodeUnknownEffect(RunRecordSchema)),
							);
						expect(restarted.runId).toBe(started.runId);
						expect(
							restarted.services.find((service) => service.name === 'web')
								?.published,
						).toBeUndefined();
						expect(
							restarted.services.find((service) => service.name === 'web')
								?.process?.pid,
						).not.toBe(
							started.services.find((service) => service.name === 'web')
								?.process?.pid,
						);
						expect(
							restarted.services.find((service) => service.name === 'db')
								?.process?.pid,
						).toBe(dbPid);
						yield* Effect.sleep('100 millis');
						const replay = yield* logs.replayAndSubscribe(
							{ runId: 'run', serviceName: 'web' },
							0,
							() => Effect.void,
						);
						yield* replay.unsubscribe;
						const content = replay.replay.map((event) => event.data).join('');
						expect(content.match(/generation:original/g)).toHaveLength(2);
						expect(content).toContain('--- devsess: restarted web ---');
					}).pipe(Effect.provide(layer(directory, socketPath)));
				}),
			),
	);
	it.live('returns daemon info and closes through the shutdown request', () =>
		runTest(
			Effect.gen(function* () {
				const directory = yield* makeTempDir;
				const socketPath = join(directory, 'daemon.sock');
				yield* Effect.gen(function* () {
					const daemon = yield* Daemon;
					const value = yield* daemon
						.request(info)
						.pipe(Effect.flatMap(Schema.decodeUnknownEffect(DaemonInfo)));
					expect(value.pid).toBe(process.pid);
					expect(value.socketPath).toBe(socketPath);
					expect(value.dataDirectory).toBe(directory);
					expect(value.logsDirectory).toBe(join(directory, 'logs'));
					expect(value.protocolVersion).toBe(1);
					yield* daemon.request(shutdown);
					yield* daemon.awaitShutdown;
				}).pipe(Effect.provide(layer(directory, socketPath)));
			}),
		),
	);

	it.live(
		'replays output printed before ownership capture for a running service',
		() =>
			runTest(
				Effect.gen(function* () {
					const directory = yield* makeTempDir;
					const socketPath = join(directory, 'daemon.sock');
					yield* Effect.gen(function* () {
						const daemon = yield* Daemon;
						const run = yield* daemon
							.request(start('printf early-running; exec sleep 30'))
							.pipe(
								Effect.flatMap(Schema.decodeUnknownEffect(RunRecordSchema)),
							);
						expect(run.services[0]?.state).toBe('running');
						yield* checkReplay('early-running');
						const socket = yield* Effect.acquireRelease(
							Effect.sync(() => createConnection(socketPath)),
							(socket) => Effect.sync(() => socket.destroy()),
						);
						expect(yield* tail(socket, 'early-running')).toContain(
							'early-running',
						);
					}).pipe(Effect.provide(layer(directory, socketPath)));
				}),
			),
	);

	for (const exitCode of [0, 7]) {
		it.live(
			`retains immediate output and exit ${exitCode} before ownership capture`,
			() =>
				runTest(
					Effect.gen(function* () {
						const directory = yield* makeTempDir;
						const socketPath = join(directory, 'daemon.sock');
						yield* Effect.gen(function* () {
							const daemon = yield* Daemon;
							const run = yield* daemon
								.request(start(`printf early-exit; exit ${exitCode}`))
								.pipe(
									Effect.flatMap(Schema.decodeUnknownEffect(RunRecordSchema)),
								);
							expect(run.services[0]?.state).toBe(
								exitCode === 0 ? 'exited' : 'failed',
							);
							expect(run.services[0]?.process).toBeUndefined();
							yield* checkReplay('early-exit');
						}).pipe(Effect.provide(layer(directory, socketPath)));
					}),
				),
		);
	}
});
