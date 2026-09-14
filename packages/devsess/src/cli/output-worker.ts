import { Deferred, Effect, Fiber, Queue } from 'effect';
import type { FileSystem } from 'effect/FileSystem';
import type { Path } from 'effect/Path';
import type { Scope } from 'effect/Scope';
import type { IPty } from 'node-pty';
import type { LogAddress, LogsService } from './logs';

export const MAX_OUTPUT_BACKLOG_BYTES = 256 * 1024;

export type OutputState = {
	readonly address: LogAddress;
	readonly terminal: IPty;
	readonly queue: Queue.Queue<void>;
	readonly pendingWaiters: Set<Deferred.Deferred<void>>;
	pending: string;
	pendingBytes: number;
	processing: boolean;
	paused: boolean;
	closed: boolean;
	failed: boolean;
	failureQueued: boolean;
	worker: Fiber.Fiber<void, unknown> | undefined;
};

export type OutputWorker = {
	readonly start: (
		address: LogAddress,
		terminal: IPty,
	) => Effect.Effect<OutputState, never, FileSystem | Path | Scope>;
	readonly enqueue: (address: LogAddress, data: string) => void;
	readonly awaitIdle: (address: LogAddress) => Effect.Effect<void>;
	readonly close: (address: LogAddress) => Effect.Effect<void>;
};

export const makeOutputWorker = (options: {
	readonly logs: LogsService;
	readonly onPersistenceFailure: (address: LogAddress, cause: unknown) => void;
}): Effect.Effect<OutputWorker, never, FileSystem | Path | Scope> =>
	Effect.gen(function* () {
		const outputs = new Map<string, OutputState>();
		const serviceKey = (address: LogAddress) =>
			`${address.runId}:${address.serviceName}`;
		const settleOutputWaiters = (output: OutputState) => {
			if (output.processing || output.pendingBytes > 0) return Effect.void;
			const waiters = Array.from(output.pendingWaiters);
			output.pendingWaiters.clear();
			return Effect.forEach(
				waiters,
				(waiter) => Deferred.succeed(waiter, undefined),
				{ discard: true },
			);
		};
		const awaitIdle = (address: LogAddress) =>
			Effect.suspend(() => {
				const output = outputs.get(serviceKey(address));
				if (
					output === undefined ||
					(!output.processing && output.pendingBytes === 0)
				)
					return Effect.void;
				return Effect.gen(function* () {
					const waiter = yield* Deferred.make<void>();
					output.pendingWaiters.add(waiter);
					yield* settleOutputWaiters(output);
					yield* Deferred.await(waiter);
				});
			});
		const close = (address: LogAddress) =>
			Effect.suspend(() => {
				const key = serviceKey(address);
				const output = outputs.get(key);
				if (output === undefined) return Effect.void;
				output.closed = true;
				output.pending = '';
				output.pendingBytes = 0;
				return settleOutputWaiters(output).pipe(
					Effect.andThen(
						output.worker === undefined
							? Effect.void
							: Fiber.interrupt(output.worker),
					),
					Effect.tap(() =>
						Effect.sync(() => {
							outputs.delete(key);
						}),
					),
				);
			});
		const enqueue = (address: LogAddress, data: string) => {
			const output = outputs.get(serviceKey(address));
			if (output === undefined || output.closed || output.failed) return;
			output.pending += data;
			output.pendingBytes += Buffer.byteLength(data);
			if (output.pendingBytes > MAX_OUTPUT_BACKLOG_BYTES && !output.paused) {
				output.paused = true;
				output.terminal.pause();
			}
			Queue.offerUnsafe(output.queue, undefined);
		};
		const start = (address: LogAddress, terminal: IPty) =>
			Effect.gen(function* () {
				const queue = yield* Queue.bounded<void>(1);
				const output: OutputState = {
					address,
					terminal,
					queue,
					pendingWaiters: new Set(),
					pending: '',
					pendingBytes: 0,
					processing: false,
					paused: false,
					closed: false,
					failed: false,
					failureQueued: false,
					worker: undefined,
				};
				outputs.set(serviceKey(address), output);
				const worker = yield* Effect.forever(
					Queue.take(queue).pipe(
						Effect.flatMap(() => {
							if (output.closed || output.failed) return Effect.void;
							const data = output.pending;
							output.pending = '';
							output.pendingBytes = 0;
							if (data === '') return settleOutputWaiters(output);
							output.processing = true;
							return options.logs.append(address, data).pipe(
								Effect.asVoid,
								Effect.catch((cause) =>
									Effect.sync(() => {
										output.failed = true;
										output.pending = '';
										output.pendingBytes = 0;
										if (!output.failureQueued) {
											output.failureQueued = true;
											options.onPersistenceFailure(address, cause);
										}
									}),
								),
								Effect.ensuring(
									Effect.sync(() => {
										output.processing = false;
										if (
											output.paused &&
											output.pendingBytes <= MAX_OUTPUT_BACKLOG_BYTES / 2
										) {
											output.paused = false;
											output.terminal.resume();
										}
									}).pipe(
										Effect.andThen(
											Effect.suspend(() => settleOutputWaiters(output)),
										),
									),
								),
							);
						}),
					),
				).pipe(Effect.forkScoped);
				output.worker = worker;
				return output;
			});
		return { start, enqueue, awaitIdle, close };
	});
