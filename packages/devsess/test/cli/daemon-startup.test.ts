import { createConnection, type Socket } from 'node:net';
import { join } from 'node:path';
import { describe, expect, it } from '@effect/vitest';
import { Effect, Layer, Schema } from 'effect';
import { Daemon, makeDaemon } from '../../src/cli/daemon';
import { Logs } from '../../src/cli/logs';
import { Processes } from '../../src/cli/processes';
import type { DaemonRequest } from '../../src/cli/protocol';
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
	return Layer.effect(Daemon, makeDaemon({ socketPath })).pipe(
		Layer.provideMerge(dependencies),
	);
};
const start = (command: string): DaemonRequest => ({
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
