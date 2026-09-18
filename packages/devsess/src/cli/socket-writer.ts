import type { Socket } from 'node:net';
import { Effect, Stream } from 'effect';
import {
	type DaemonEvent,
	type DaemonResponse,
	LIVE_OUTPUT_OVERFLOW_MESSAGE,
	MAX_FRAME_BYTES,
	PROTOCOL_VERSION,
} from './protocol';

export type SocketWriterFrame = DaemonResponse | DaemonEvent;

type QueuedFrame = {
	readonly encoded: string;
	readonly bytes: number;
};

export type SocketWriterReplay =
	| ReadonlyArray<SocketWriterFrame>
	| Stream.Stream<SocketWriterFrame, unknown, unknown>;

type SocketWriterOptions = {
	readonly maxBytes?: number;
	readonly onClose: () => void;
};

export type SocketWriter = {
	readonly send: (frame: SocketWriterFrame) => Effect.Effect<void>;
	readonly sendReplay: {
		(source: ReadonlyArray<SocketWriterFrame>): Effect.Effect<void>;
		<E, R>(
			source: Stream.Stream<SocketWriterFrame, E, R>,
		): Effect.Effect<void, E, R>;
	};
	readonly overflow: (requestId: string) => Effect.Effect<void>;
	readonly awaitIdle: Effect.Effect<void>;
	readonly close: () => void;
	readonly isClosed: () => boolean;
};

const overflowMessage = 'Daemon output buffer exceeded 1 MiB; disconnecting';
const OVERFLOW_DRAIN_TIMEOUT_MS = 3_000;

export const makeSocketWriter = (
	socket: Socket,
	options: SocketWriterOptions,
): SocketWriter => {
	const maxBytes =
		options.maxBytes === undefined ? MAX_FRAME_BYTES : options.maxBytes;
	const queue: Array<QueuedFrame> = [];
	const drainWaiters = new Set<() => void>();
	const idleWaiters = new Set<() => void>();
	const replayWaiters: Array<() => void> = [];
	let queuedBytes = 0;
	let pumping = false;
	let replayActive = false;
	let closed = false;
	let overflowing = false;
	let overflowTimer: ReturnType<typeof setTimeout> | undefined;

	const releaseIdleWaiters = () => {
		const idles = Array.from(idleWaiters);
		idleWaiters.clear();
		for (const resolve of idles) resolve();
	};
	const releaseReplayWaiters = () => {
		const replay = replayWaiters.splice(0);
		for (const resolve of replay) resolve();
	};
	const clearOverflowTimer = () => {
		const timer = overflowTimer;
		if (timer === undefined) return;
		clearTimeout(timer);
		overflowTimer = undefined;
	};
	const releaseWaiters = () => {
		const drains = Array.from(drainWaiters);
		drainWaiters.clear();
		for (const resolve of drains) resolve();
		releaseIdleWaiters();
		releaseReplayWaiters();
	};
	const cleanup = (notify: boolean) => {
		if (closed) return;
		closed = true;
		clearOverflowTimer();
		queue.length = 0;
		queuedBytes = 0;
		replayActive = false;
		socket.off('close', onClose);
		socket.off('error', onError);
		releaseWaiters();
		if (notify) options.onClose();
	};
	const onClose = () => cleanup(true);
	const destroySocket = () => {
		if (!socket.destroyed) socket.destroy();
	};
	const onError = () => {
		cleanup(true);
		destroySocket();
	};
	socket.once('close', onClose);
	socket.once('error', onError);

	const waitForDrain = () => {
		if (closed || socket.destroyed || !socket.writable)
			return Promise.resolve();
		return new Promise<void>((resolve) => {
			const finish = () => {
				socket.off('drain', finish);
				socket.off('close', finish);
				socket.off('error', finish);
				drainWaiters.delete(finish);
				resolve();
			};
			drainWaiters.add(finish);
			socket.once('drain', finish);
			socket.once('close', finish);
			socket.once('error', finish);
			if (!socket.writableNeedDrain) finish();
		});
	};
	const pump = () => {
		if (pumping || replayActive || closed || overflowing) return;
		const item = queue.shift();
		if (item === undefined) {
			if (queuedBytes === 0) releaseIdleWaiters();
			return;
		}
		pumping = true;
		try {
			let completed = false;
			const complete = () => {
				if (completed || closed) return;
				completed = true;
				queuedBytes -= item.bytes;
				if (!pumping && queue.length === 0 && queuedBytes === 0)
					releaseIdleWaiters();
			};
			const accepted = socket.write(item.encoded, complete);
			if (accepted) {
				pumping = false;
				pump();
				return;
			}
			void waitForDrain().then(() => {
				if (closed) {
					pumping = false;
					return;
				}
				complete();
				pumping = false;
				if (queue.length === 0 && queuedBytes === 0) releaseIdleWaiters();
				pump();
			});
		} catch {
			pumping = false;
			cleanup(true);
			destroySocket();
		}
	};
	const discardQueuedFrames = () => {
		for (const item of queue) queuedBytes -= item.bytes;
		queue.length = 0;
	};
	const writeOverflow = (requestId: string, message: string) => {
		if (closed || overflowing) return;
		overflowing = true;
		discardQueuedFrames();
		replayActive = false;
		releaseReplayWaiters();
		releaseIdleWaiters();
		const encoded = `${JSON.stringify({
			version: PROTOCOL_VERSION,
			requestId,
			ok: false,
			error: message,
		})}\n`;
		let drained = false;
		let written = false;
		const closeAfterDrain = () => {
			if (closed || !drained || !written) return;
			cleanup(true);
			destroySocket();
		};
		const timeout = setTimeout(() => {
			if (closed) return;
			cleanup(true);
			destroySocket();
		}, OVERFLOW_DRAIN_TIMEOUT_MS);
		timeout.unref();
		overflowTimer = timeout;
		try {
			const accepted = socket.write(encoded, () => {
				written = true;
				closeAfterDrain();
			});
			if (accepted) {
				drained = true;
				closeAfterDrain();
				return;
			}
			void waitForDrain().then(() => {
				drained = true;
				closeAfterDrain();
			});
		} catch {
			cleanup(true);
			destroySocket();
		}
	};
	const send = (frame: SocketWriterFrame) =>
		Effect.sync(() => {
			if (closed || overflowing) return;
			const encoded = `${JSON.stringify(frame)}\n`;
			const bytes = Buffer.byteLength(encoded);
			if (bytes > maxBytes || queuedBytes + bytes > maxBytes) {
				writeOverflow(
					frame.requestId,
					'event' in frame && frame.event === 'output'
						? LIVE_OUTPUT_OVERFLOW_MESSAGE
						: overflowMessage,
				);
				return;
			}
			queue.push({ encoded, bytes });
			queuedBytes += bytes;
			pump();
		});
	const acquireReplay = () =>
		Effect.promise(
			() =>
				new Promise<void>((resolve) => {
					if (closed || overflowing || !replayActive) {
						replayActive = !closed && !overflowing;
						resolve();
						return;
					}
					replayWaiters.push(() => {
						replayActive = !closed;
						resolve();
					});
				}),
		);
	const releaseReplay = () =>
		Effect.sync(() => {
			if (!replayActive) return;
			replayActive = false;
			const next = replayWaiters.shift();
			if (next !== undefined) next();
			pump();
			if (queue.length === 0 && queuedBytes === 0) releaseIdleWaiters();
		});
	const writeReplayFrame = (frame: SocketWriterFrame) =>
		Effect.promise(
			() =>
				new Promise<void>((resolve) => {
					if (closed || overflowing || socket.destroyed || !socket.writable) {
						resolve();
						return;
					}
					const encoded = `${JSON.stringify(frame)}\n`;
					try {
						const accepted = socket.write(encoded);
						if (accepted) {
							resolve();
							return;
						}
						void waitForDrain().then(resolve);
					} catch {
						cleanup(true);
						if (!socket.destroyed) socket.destroy();
						resolve();
					}
				}),
		);
	const sendReplay = ((source: SocketWriterReplay) =>
		Effect.gen(function* () {
			yield* acquireReplay();
			if (closed || overflowing) return;
			const replay: Stream.Stream<SocketWriterFrame, unknown, unknown> =
				Array.isArray(source)
					? Stream.fromIterable(source)
					: (source as Stream.Stream<SocketWriterFrame, unknown, unknown>);
			yield* Stream.runForEach(replay, (frame) => writeReplayFrame(frame));
		}).pipe(Effect.ensuring(releaseReplay()))) as SocketWriter['sendReplay'];
	const overflow = (requestId: string) =>
		Effect.sync(() => writeOverflow(requestId, LIVE_OUTPUT_OVERFLOW_MESSAGE));
	const awaitIdle = Effect.promise(
		() =>
			new Promise<void>((resolve) => {
				if (
					closed ||
					overflowing ||
					(!pumping && !replayActive && queue.length === 0 && queuedBytes === 0)
				) {
					resolve();
					return;
				}
				idleWaiters.add(resolve);
			}),
	);
	return {
		send,
		sendReplay,
		overflow,
		awaitIdle,
		close: () => cleanup(false),
		isClosed: () => closed,
	};
};
