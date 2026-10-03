import { createServer } from 'node:net';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import { Effect } from 'effect';
import { io, sharedGraceMs, startupLock } from './shared-protocol';
import type { ServiceError } from './core';

export const serveHost = (
	dataDir: string,
	line: string,
	stop: Effect.Effect<void>,
	graceMs = sharedGraceMs,
) =>
	Effect.callback<void, ServiceError>((resume) => {
		const state = {
			consumers: 0,
			stopping: false,
			timer: undefined as ReturnType<typeof setTimeout> | undefined,
		};
		const schedule = () => {
			if (state.timer !== undefined) clearTimeout(state.timer);
			state.timer = setTimeout(() => {
				Effect.runFork(
					Effect.scoped(
						Effect.gen(function* () {
							yield* Effect.acquireRelease(startupLock(dataDir), (release) =>
								io(release).pipe(Effect.orDie),
							);
							if (state.consumers !== 0) return;
							state.stopping = true;
							yield* io(() => rm(join(dataDir, 'host.sock'), { force: true }));
							server.close();
							yield* stop;
						}),
					).pipe(
						Effect.matchCauseEffect({
							onFailure: (cause) =>
								Effect.sync(() => resume(Effect.failCause(cause))),
							onSuccess: () =>
								Effect.sync(() => {
									if (state.stopping) resume(Effect.void);
								}),
						}),
					),
				);
			}, graceMs);
		};
		const server = createServer((socket) => {
			if (state.stopping) {
				socket.destroy();
				return;
			}
			state.consumers++;
			if (state.timer !== undefined) clearTimeout(state.timer);
			socket.on('error', () => socket.destroy());
			socket.once('close', () => {
				state.consumers--;
				if (state.consumers === 0) schedule();
			});
			socket.write(`${line}\n`);
		});
		server.once('error', (cause) => resume(Effect.die(cause)));
		server.listen(join(dataDir, 'host.sock'), schedule);
		return Effect.sync(() => {
			if (state.timer !== undefined) clearTimeout(state.timer);
			server.close();
		});
	});
