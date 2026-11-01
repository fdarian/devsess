import { Deferred, Effect, Fiber, Option, Queue } from 'effect';
import type { FileSystem } from 'effect/FileSystem';
import type { Path } from 'effect/Path';
import type { Scope } from 'effect/Scope';
import type { IPty } from 'node-pty';
import type { LogAddress, LogsService } from './logs';
import { OUTPUT_IDLE_TIMEOUT_MS } from './termination';

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
	draining: boolean;
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
	readonly enqueue: (address: LogAddress, terminal: IPty, data: string) => void;
	readonly awaitIdle: (
		address: LogAddress,
		terminal?: IPty,
	) => Effect.Effect<void>;
	readonly close: (address: LogAddress, terminal?: IPty) => Effect.Effect<void>;
	/** Stops applying backpressure for good and resumes a paused terminal. Call before terminating the process: node-pty destroys a paused socket 200ms after the leader exits, dropping whatever it had not read yet. */
	readonly releaseBackpressure: (
		address: LogAddress,
		terminal: IPty,
	) => Effect.Effect<void>;
	readonly appendMarker: (
		address: LogAddress,
		data: string,
	) => Effect.Effect<void, unknown, FileSystem | Path>;
};

export const makeOutputWorker = (options: {
	readonly logs: LogsService;
	readonly onPersistenceFailure: (address: LogAddress, cause: unknown) => void;
	readonly idleTimeoutMs?: number;
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
		const idleTimeoutMs =
			options.idleTimeoutMs === undefined
				? OUTPUT_IDLE_TIMEOUT_MS
				: options.idleTimeoutMs;
		const awaitIdle = (address: LogAddress, terminal?: IPty) =>
			Effect.suspend(() => {
				const output = outputs.get(serviceKey(address));
				if (
					output === undefined ||
					(terminal !== undefined && output.terminal !== terminal) ||
					(!output.processing && output.pendingBytes === 0)
				)
					return Effect.void;
				return Effect.gen(function* () {
					const waiter = yield* Deferred.make<void>();
					output.pendingWaiters.add(waiter);
					yield* settleOutputWaiters(output);
					const settled = yield* Deferred.await(waiter).pipe(
						Effect.timeoutOption(idleTimeoutMs),
					);
					if (Option.isSome(settled)) return;
					output.pendingWaiters.delete(waiter);
					yield* Effect.logWarning(
						`Abandoning unflushed output for ${serviceKey(address)} after ${idleTimeoutMs}ms`,
					);
				});
			});
		const close = (address: LogAddress, terminal?: IPty) =>
			Effect.suspend(() => {
				const key = serviceKey(address);
				const output = outputs.get(key);
				if (
					output === undefined ||
					(terminal !== undefined && output.terminal !== terminal)
				)
					return Effect.void;
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
							if (outputs.get(key) === output) outputs.delete(key);
						}),
					),
				);
			});
		const releaseBackpressure = (address: LogAddress, terminal: IPty) =>
			Effect.sync(() => {
				const output = outputs.get(serviceKey(address));
				if (output === undefined || output.terminal !== terminal) return;
				output.draining = true;
				if (!output.paused) return;
				output.paused = false;
				output.terminal.resume();
			});
		const enqueue = (address: LogAddress, terminal: IPty, data: string) => {
			const output = outputs.get(serviceKey(address));
			if (
				output === undefined ||
				output.terminal !== terminal ||
				output.closed ||
				output.failed
			)
				return;
			output.pending += data;
			output.pendingBytes += Buffer.byteLength(data);
			if (
				output.pendingBytes > MAX_OUTPUT_BACKLOG_BYTES &&
				!output.paused &&
				!output.draining
			) {
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
					draining: false,
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
		return {
			start,
			enqueue,
			awaitIdle,
			close,
			releaseBackpressure,
			appendMarker: (address, data) =>
				options.logs.append(address, data).pipe(Effect.asVoid),
		};
	});
