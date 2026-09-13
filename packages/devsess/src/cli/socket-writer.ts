import type { Socket } from 'node:net';
import { Effect } from 'effect';
import {
	type DaemonEvent,
	type DaemonResponse,
	MAX_FRAME_BYTES,
	PROTOCOL_VERSION,
} from './protocol';

export type SocketWriterFrame = DaemonResponse | DaemonEvent;

type QueuedFrame = {
	readonly encoded: string;
	readonly bytes: number;
};

type SocketWriterOptions = {
	readonly maxBytes?: number;
	readonly onClose: () => void;
};

export type SocketWriter = {
	readonly send: (frame: SocketWriterFrame) => Effect.Effect<void>;
	readonly overflow: (requestId: string) => Effect.Effect<void>;
	readonly awaitIdle: Effect.Effect<void>;
	readonly close: () => void;
	readonly isClosed: () => boolean;
};

const overflowMessage = 'Daemon output buffer exceeded 1 MiB; disconnecting';

export const makeSocketWriter = (
	socket: Socket,
	options: SocketWriterOptions,
): SocketWriter => {
	const maxBytes =
		options.maxBytes === undefined ? MAX_FRAME_BYTES : options.maxBytes;
	const queue: Array<QueuedFrame> = [];
	const drainWaiters = new Set<() => void>();
	const idleWaiters = new Set<() => void>();
	let queuedBytes = 0;
	let pumping = false;
	let closed = false;

	const releaseWaiters = () => {
		const drains = Array.from(drainWaiters);
		const idles = Array.from(idleWaiters);
		drainWaiters.clear();
		idleWaiters.clear();
		for (const resolve of drains) resolve();
		for (const resolve of idles) resolve();
	};
	const releaseIdleWaiters = () => {
		const idles = Array.from(idleWaiters);
		idleWaiters.clear();
		for (const resolve of idles) resolve();
	};
	const cleanup = (notify: boolean) => {
		if (closed) return;
		closed = true;
		queue.length = 0;
		queuedBytes = 0;
		socket.off('close', onClose);
		socket.off('error', onError);
		releaseWaiters();
		if (notify) options.onClose();
	};
	const onClose = () => cleanup(true);
	const onError = () => {
		cleanup(true);
		if (!socket.destroyed) socket.destroy();
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
		if (pumping || closed) return;
		const item = queue.shift();
		if (item === undefined) {
			if (queuedBytes === 0) releaseIdleWaiters();
			return;
		}
		pumping = true;
		try {
			const accepted = socket.write(item.encoded, () => {
				if (closed) return;
				queuedBytes -= item.bytes;
				if (!pumping && queue.length === 0 && queuedBytes === 0)
					releaseIdleWaiters();
			});
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
				pumping = false;
				if (queue.length === 0 && queuedBytes === 0) releaseIdleWaiters();
				pump();
			});
		} catch {
			pumping = false;
			cleanup(true);
			if (!socket.destroyed) socket.destroy();
		}
	};
	const writeOverflow = (requestId: string) => {
		if (closed) return;
		const encoded = `${JSON.stringify({
			version: PROTOCOL_VERSION,
			requestId,
			ok: false,
			error: overflowMessage,
		})}\n`;
		const canWrite =
			socket.writable &&
			!socket.destroyed &&
			!socket.writableNeedDrain &&
			socket.writableLength + Buffer.byteLength(encoded) <= maxBytes;
		if (canWrite) {
			try {
				socket.write(encoded);
			} catch {
				// Cleanup below still releases the daemon-side subscription.
			}
		}
		cleanup(true);
		if (!socket.destroyed) socket.destroy();
	};
	const send = (frame: SocketWriterFrame) =>
		Effect.sync(() => {
			if (closed) return;
			const encoded = `${JSON.stringify(frame)}\n`;
			const bytes = Buffer.byteLength(encoded);
			if (bytes > maxBytes || queuedBytes + bytes > maxBytes) {
				writeOverflow(frame.requestId);
				return;
			}
			queue.push({ encoded, bytes });
			queuedBytes += bytes;
			pump();
		});
	const overflow = (requestId: string) =>
		Effect.sync(() => writeOverflow(requestId));
	const awaitIdle = Effect.promise(
		() =>
			new Promise<void>((resolve) => {
				if (closed || (!pumping && queue.length === 0 && queuedBytes === 0)) {
					resolve();
					return;
				}
				idleWaiters.add(resolve);
			}),
	);
	return {
		send,
		overflow,
		awaitIdle,
		close: () => cleanup(false),
		isClosed: () => closed,
	};
};
