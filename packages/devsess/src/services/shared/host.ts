import { rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { join } from 'node:path';
import { Effect } from 'effect';
import type { ServiceError } from '../core';
import { io, sharedGraceMs, socketPath, startupLock } from './protocol';

export const serveHost = (
	dataDir: string,
	line: string,
	stop: Effect.Effect<void>,
	graceMs = sharedGraceMs,
) =>
	Effect.gen(function* () {
		const address = yield* io(() => socketPath(dataDir));
		return yield* Effect.callback<void, ServiceError>((resume) => {
			const state = {
				consumers: 0,
				stopping: false,
				timer: undefined as ReturnType<typeof setTimeout> | undefined,
			};
			const shutdown = Effect.gen(function* () {
				yield* Effect.acquireRelease(startupLock(dataDir), (release) =>
					io(release).pipe(Effect.orDie),
				);
				if (state.consumers !== 0) return;
				state.stopping = true;
				server.close();
				yield* io(() => rm(join(dataDir, 'host.sock'), { force: true })).pipe(
					Effect.ensuring(stop),
				);
			}).pipe(
				Effect.scoped,
				Effect.matchCauseEffect({
					onFailure: (cause) =>
						Effect.sync(() => resume(Effect.failCause(cause))),
					onSuccess: () =>
						Effect.sync(() => {
							if (state.stopping) resume(Effect.void);
						}),
				}),
			);
			const schedule = () => {
				if (state.timer !== undefined) clearTimeout(state.timer);
				state.timer = setTimeout(() => Effect.runFork(shutdown), graceMs);
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
			server.listen(address, schedule);
			return Effect.suspend(() =>
				state.stopping
					? Effect.void
					: Effect.sync(() => {
							if (state.timer !== undefined) clearTimeout(state.timer);
							server.close();
						}).pipe(
							Effect.ensuring(
								io(() => rm(join(dataDir, 'host.sock'), { force: true })).pipe(
									Effect.orDie,
								),
							),
						),
			);
		});
	});
