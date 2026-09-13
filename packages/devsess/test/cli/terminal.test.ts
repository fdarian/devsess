import { EventEmitter } from 'node:events';
import { createConnection } from 'node:net';
import { describe, expect, it } from '@effect/vitest';
import { Effect, Queue } from 'effect';
import { afterEach, vi } from 'vitest';
import { openDaemonStream } from '../../src/cli/terminal';

vi.mock('node:net', () => ({ createConnection: vi.fn() }));

afterEach(() => {
	vi.restoreAllMocks();
});

describe('daemon terminal streams', () => {
	it.effect('preserves UTF-8 characters split across socket chunks', () =>
		Effect.scoped(
			Effect.gen(function* () {
				let socket:
					| (EventEmitter & {
							write: ReturnType<typeof vi.fn>;
							destroy: ReturnType<typeof vi.fn>;
					  })
					| undefined;
				vi.mocked(createConnection).mockImplementation(() => {
					const connection = Object.assign(new EventEmitter(), {
						write: vi.fn(() => true),
						destroy: vi.fn(),
					});
					socket = connection;
					queueMicrotask(() => connection.emit('connect'));
					return connection as unknown as ReturnType<typeof createConnection>;
				});
				const stream = yield* openDaemonStream({
					socketPath: '/tmp/devsess-test.sock',
					request: {
						version: 1,
						requestId: 'tail',
						method: 'tail',
						params: { runId: 'run', serviceName: 'web' },
					},
				});
				if (socket === undefined) return yield* Effect.die('Missing socket');
				const frame = {
					version: 1 as const,
					requestId: 'tail',
					event: 'output' as const,
					data: '🦄',
					offset: 4,
				};
				const encoded = Buffer.from(`${JSON.stringify(frame)}\n`);
				const marker = encoded.indexOf(Buffer.from('🦄'));
				if (marker < 0) return yield* Effect.die('Missing UTF-8 marker');
				socket.emit('data', encoded.subarray(0, marker + 1));
				socket.emit('data', encoded.subarray(marker + 1));
				const received = yield* Queue.take(stream.frames);
				expect(received._tag).toBe('output');
				if (received._tag === 'output') {
					expect(received.value.event).toBe('output');
					if (received.value.event === 'output')
						expect(received.value.data).toBe('🦄');
				}
			}),
		),
	);
});
