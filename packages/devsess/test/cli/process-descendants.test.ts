import { spawn } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from '@effect/vitest';
import { Effect, Layer } from 'effect';
import { Daemon, makeDaemon } from '../../src/cli/daemon';
import { Logs } from '../../src/cli/logs';
import { Processes } from '../../src/cli/processes';
import type { DaemonRequest } from '../../src/cli/protocol';
import { Registry } from '../../src/cli/registry';
import { runTest } from '../support/run-test';
import { makeTempDir } from '../support/temp-dir';

const script = `
const { spawn } = require('node:child_process');
const { existsSync, writeFileSync } = require('node:fs');
const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
  detached: true, stdio: 'ignore'
});
child.unref();
writeFileSync(process.argv[1], String(child.pid));
setInterval(() => {
  if (existsSync(process.argv[2])) process.exit(0);
}, 20);
`;

const waitUntil = (
	condition: () => boolean,
	deadline: number,
): Effect.Effect<void> =>
	Effect.gen(function* () {
		if (condition()) return;
		if (Date.now() >= deadline)
			return yield* Effect.die('Timed out waiting for detached child fixture');
		yield* Effect.sleep('25 millis');
		return yield* waitUntil(condition, deadline);
	});

describe('escaped service descendants', () => {
	it.live('stopping a daemon run cleans its detached child', () =>
		runTest(
			Effect.gen(function* () {
				const directory = yield* makeTempDir;
				const pidFile = join(directory, 'child.pid');
				const releaseFile = join(directory, 'release');
				const encoded = Buffer.from(script).toString('base64');
				const command = `${process.execPath} -e "eval(Buffer.from('${encoded}','base64').toString())" ${pidFile} ${releaseFile}`;
				const start: DaemonRequest = {
					version: 1,
					requestId: 'start',
					method: 'startRun',
					params: {
						runId: 'detached-test',
						projectName: 'fixture',
						presetName: 'default',
						canonicalCwd: directory,
						invocationCwd: directory,
						configSnapshot: {},
						environment: {},
						services: [{ name: 'web', command, cwd: directory }],
					},
				};
				const dependencies = Layer.mergeAll(
					Registry.layer({ dataDirectory: directory }),
					Logs.layer({ dataDirectory: directory, maxBytes: 4096 }),
					Processes.layer,
				);
				const layer = Layer.effect(
					Daemon,
					makeDaemon({
						dataDirectory: directory,
						socketPath: join(directory, 'daemon.sock'),
					}),
				).pipe(Layer.provideMerge(dependencies));
				yield* Effect.gen(function* () {
					const daemon = yield* Daemon;
					const processes = yield* Processes;
					yield* daemon.request(start);
					yield* waitUntil(() => existsSync(pidFile), Date.now() + 5_000);
					const child = yield* processes.capture(
						Number(readFileSync(pidFile, 'utf8')),
					);
					yield* Effect.sleep('1500 millis');
					const stopped = yield* daemon.request({
						version: 1,
						requestId: 'stop',
						method: 'stopRun',
						params: { runId: 'detached-test' },
					});
					expect(stopped).toMatchObject({ state: 'exited' });
					expect(yield* processes.owns(child)).toBe(false);
				}).pipe(Effect.provide(layer));
			}),
		),
	);
	for (const leaderExits of [false, true]) {
		it.live(
			leaderExits
				? 'cleans a detached grandchild after the leader exits on its own'
				: 'cleans a detached grandchild on explicit stop',
			() =>
				runTest(
					Effect.gen(function* () {
						const directory = yield* makeTempDir;
						const pidFile = join(directory, 'child.pid');
						const releaseFile = join(directory, 'release');
						const leader = spawn(
							process.execPath,
							['-e', script, pidFile, releaseFile],
							{
								detached: true,
								stdio: 'ignore',
							},
						);
						const pid = leader.pid;
						if (pid === undefined)
							return yield* Effect.die('Leader did not start');
						const processes = yield* Processes.make;
						const ownership = yield* processes.captureLive(pid);
						yield* waitUntil(() => existsSync(pidFile), Date.now() + 5_000);
						const childPid = Number(readFileSync(pidFile, 'utf8'));
						const child = yield* processes.capture(childPid);
						const exercise = Effect.gen(function* () {
							yield* Effect.sleep('1500 millis');
							if (leaderExits) {
								writeFileSync(releaseFile, 'exit');
								const awaitExit: Effect.Effect<void, unknown> = Effect.suspend(
									() =>
										processes
											.owns(ownership.identity)
											.pipe(
												Effect.flatMap((alive) =>
													alive
														? Effect.sleep('25 millis').pipe(
																Effect.andThen(awaitExit),
															)
														: Effect.void,
												),
											),
								);
								yield* awaitExit.pipe(Effect.timeout('5 seconds'));
							}
							yield* ownership.terminate;
							expect(yield* processes.owns(child)).toBe(false);
						});
						yield* exercise.pipe(
							Effect.ensuring(
								Effect.gen(function* () {
									if (yield* processes.owns(child))
										yield* Effect.sync(() =>
											process.kill(child.pid, 'SIGKILL'),
										);
									if (yield* processes.owns(ownership.identity))
										yield* ownership.terminate;
								}).pipe(Effect.orDie),
							),
						);
					}),
				),
		);
	}
});
