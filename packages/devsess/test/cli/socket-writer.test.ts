import { Socket } from 'node:net';
import { describe, expect, it } from '@effect/vitest';
import { Effect } from 'effect';
import { vi } from 'vitest';
import { makeSocketWriter } from '../../src/cli/socket-writer';

const response = {
	version: 1 as const,
	requestId: 'request',
	ok: true,
	result: {},
};

describe('socket writer', () => {
	it.effect(
		'releases its waiters and close callback when the socket closes',
		() =>
			Effect.gen(function* () {
				const socket = new Socket();
				const onClose = vi.fn();
				const writer = makeSocketWriter(socket, { onClose, maxBytes: 1024 });
				vi.spyOn(socket, 'write').mockReturnValue(false);
				yield* writer.send(response);
				const idle = Effect.runPromise(writer.awaitIdle);
				socket.emit('close');
				yield* Effect.promise(() => idle);
				expect(writer.isClosed()).toBe(true);
				expect(onClose).toHaveBeenCalledOnce();
			}),
	);

	it.effect(
		'reports an overflow before destroying a socket that can accept it',
		() =>
			Effect.gen(function* () {
				const socket = new Socket();
				const written: Array<string> = [];
				const writer = makeSocketWriter(socket, {
					onClose: () => undefined,
					maxBytes: 256,
				});
				vi.spyOn(socket, 'write').mockImplementation((chunk) => {
					written.push(typeof chunk === 'string' ? chunk : chunk.toString());
					return true;
				});
				const destroy = vi.spyOn(socket, 'destroy').mockReturnValue(socket);
				yield* writer.send({
					version: 1,
					requestId: 'request',
					event: 'output',
					data: 'x'.repeat(300),
					offset: 300,
				});
				expect(written).toHaveLength(1);
				expect(JSON.parse(written[0] as string)).toMatchObject({
					ok: false,
					error: expect.stringContaining('output buffer exceeded'),
				});
				expect(writer.isClosed()).toBe(true);
				expect(destroy).toHaveBeenCalledOnce();
			}),
	);

	it.effect('retires a backpressured frame when drain arrives', () =>
		Effect.gen(function* () {
			const socket = new Socket();
			const writer = makeSocketWriter(socket, { onClose: () => undefined });
			let needDrain = true;
			Object.defineProperty(socket, 'writableNeedDrain', {
				configurable: true,
				get: () => needDrain,
			});
			vi.spyOn(socket, 'write').mockReturnValue(false);
			yield* writer.send(response);
			const idle = Effect.runPromise(writer.awaitIdle);
			needDrain = false;
			socket.emit('drain');
			yield* Effect.promise(() => idle);
			expect(writer.isClosed()).toBe(false);
		}),
	);

	it.effect(
		'streams replay frames without applying the live backlog bound',
		() =>
			Effect.gen(function* () {
				const socket = new Socket();
				const writer = makeSocketWriter(socket, {
					onClose: () => undefined,
					maxBytes: 128,
				});
				const written: Array<string> = [];
				vi.spyOn(socket, 'write').mockImplementation((chunk) => {
					written.push(typeof chunk === 'string' ? chunk : chunk.toString());
					return true;
				});
				const frames = Array.from({ length: 256 }, (_value, index) => ({
					version: 1 as const,
					requestId: 'tail',
					event: 'output' as const,
					data: 'x'.repeat(64),
					offset: index + 1,
				}));
				yield* writer.sendReplay(frames);
				expect(written).toHaveLength(frames.length);
				expect(writer.isClosed()).toBe(false);
			}),
	);
});
