import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from '@effect/vitest';
import { Effect } from 'effect';
import type { IPty } from 'node-pty';
import { resizePty, spawnPty, writePty } from '../../src/cli/pty';
import { runTest } from '../support/run-test';
import { makeTempDir } from '../support/temp-dir';

const waitForOutput = (terminal: IPty, marker: string) =>
	Effect.promise(
		() =>
			new Promise<void>((resolve) => {
				const subscription = terminal.onData((data) => {
					if (data.includes(marker)) {
						subscription.dispose();
						resolve();
					}
				});
			}),
	);

const waitForExit = (terminal: IPty) =>
	Effect.promise(
		() =>
			new Promise<{ exitCode: number; signal?: number }>((resolve) => {
				terminal.onExit((event) => resolve(event));
			}),
	);

const within = <A, E, R>(effect: Effect.Effect<A, E, R>, message: string) =>
	effect.pipe(Effect.timeout('5 seconds'), Effect.withSpan(message));

const isAlive = (pid: number) => {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
};

const waitUntil = (predicate: () => boolean) =>
	Effect.gen(function* () {
		while (!predicate()) {
			yield* Effect.sleep('20 millis');
		}
	}).pipe(Effect.timeout('5 seconds'));

describe('PTY adapter', () => {
	it.live(
		'forwards input, reports output and resize, then returns the process exit',
		() =>
			runTest(
				Effect.scoped(
					Effect.gen(function* () {
						const terminal = yield* spawnPty({
							command: '/bin/sh',
							args: [
								'-c',
								'sleep 0.1; stty size; IFS= read -r input; stty size; printf \'input:%s\' "$input"; exit 7',
							],
							cwd: process.cwd(),
							env: process.env,
							cols: 80,
							rows: 24,
						});

						yield* within(
							waitForOutput(terminal, '24 80'),
							'PTY did not produce initial output',
						);
						const resized = waitForOutput(terminal, '40 120');
						yield* resizePty(terminal, 120, 40);
						const exited = waitForExit(terminal);
						const echoed = waitForOutput(terminal, 'input:ping');
						yield* writePty(terminal, 'ping\n');
						yield* within(resized, 'PTY did not report its resize');
						yield* within(echoed, 'PTY did not echo input');
						const exit = yield* within(exited, 'PTY did not exit');
						expect(exit.exitCode).toBe(7);
					}),
				),
			),
	);

	it.live('stops the PTY process group when its owning scope closes', () =>
		runTest(
			Effect.gen(function* () {
				const rootDir = yield* makeTempDir;
				const pidPath = join(rootDir, 'grandchild.pid');
				yield* Effect.scoped(
					Effect.gen(function* () {
						const terminal = yield* spawnPty({
							command: '/bin/sh',
							args: [
								'-c',
								`sleep 0.1; sleep 30 & echo $! > ${JSON.stringify(pidPath)}; wait`,
							],
							cwd: process.cwd(),
							env: process.env,
							cols: 80,
							rows: 24,
						});
						expect(terminal.pid).toBeGreaterThan(0);
						yield* waitUntil(() => existsSync(pidPath));
					}),
				);
				const grandchildPid = Number(readFileSync(pidPath, 'utf8'));
				yield* waitUntil(() => !isAlive(grandchildPid));
				expect(isAlive(grandchildPid)).toBe(false);
			}),
		),
	);
});
