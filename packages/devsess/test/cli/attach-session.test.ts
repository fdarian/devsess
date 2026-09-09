import { describe, expect, it } from '@effect/vitest';
import { Effect, Queue } from 'effect';
import {
	awaitAttachLease,
	parseAttachInput,
} from '../../src/cli/attach-session';
import type { DaemonStreamFrame } from '../../src/cli/terminal';

describe('attach session', () => {
	it.effect('renders replay frames before accepting the lease response', () =>
		Effect.gen(function* () {
			const frames = yield* Queue.unbounded<DaemonStreamFrame>();
			yield* Queue.offer(frames, {
				_tag: 'output',
				value: {
					version: 1,
					requestId: 'request',
					event: 'output',
					data: 'replay',
					offset: 6,
				},
			});
			yield* Queue.offer(frames, {
				_tag: 'response',
				value: {
					version: 1,
					requestId: 'request',
					ok: true,
					result: { leaseId: 'lease' },
				},
			});
			const leaseId = yield* awaitAttachLease(
				{ frames },
				(message) => new Error(message),
			);
			expect(leaseId).toBe('lease');
		}),
	);

	it('treats a split double Ctrl-] sequence as a literal key', () => {
		const first = parseAttachInput(
			{ awaitingEscape: false },
			Buffer.from('\u001d'),
		);
		expect(first).toEqual({ state: { awaitingEscape: true }, actions: [] });
		expect(parseAttachInput(first.state, Buffer.from('\u001d'))).toEqual({
			state: { awaitingEscape: false },
			actions: [{ _tag: 'input', data: '\u001d' }],
		});
	});

	it('turns a lone Ctrl-] followed by another key into detach', () => {
		const first = parseAttachInput(
			{ awaitingEscape: false },
			Buffer.from('\u001d'),
		);
		expect(parseAttachInput(first.state, Buffer.from('x'))).toEqual({
			state: { awaitingEscape: false },
			actions: [{ _tag: 'detach' }],
		});
	});
});
