import { StringDecoder } from 'node:string_decoder';
import { describe, expect, it } from '@effect/vitest';
import { Cause, Effect, Queue, Runtime } from 'effect';
import {
	awaitAttachLease,
	parseAttachInput,
} from '../../src/cli/attach-session';
import { ServiceExitError } from '../../src/cli/exit-status';
import {
	type DaemonStreamFrame,
	decodeDaemonStreamFrame,
} from '../../src/cli/terminal';

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

	it.effect('returns success for a zero exit before the lease', () =>
		Effect.gen(function* () {
			const frames = yield* Queue.unbounded<DaemonStreamFrame>();
			yield* Queue.offer(frames, {
				_tag: 'output',
				value: {
					version: 1,
					requestId: 'request',
					event: 'exit',
					exitCode: 0,
				},
			});
			const leaseId = yield* awaitAttachLease(
				{ frames },
				(message) => new Error(message),
			);
			expect(leaseId).toBeUndefined();
		}),
	);

	it.effect(
		'preserves a nonzero service completion status before the lease',
		() =>
			Effect.gen(function* () {
				const frames = yield* Queue.unbounded<DaemonStreamFrame>();
				yield* Queue.offer(frames, {
					_tag: 'output',
					value: {
						version: 1,
						requestId: 'request',
						event: 'exit',
						exitCode: 7,
					},
				});
				const result = yield* Effect.exit(
					awaitAttachLease({ frames }, (message) => new Error(message)).pipe(
						Effect.timeout('1 second'),
					),
				);
				expect(result._tag).toBe('Failure');
				if (result._tag === 'Failure') {
					const error = Cause.squash(result.cause);
					expect(error).toBeInstanceOf(ServiceExitError);
					expect(Runtime.getErrorExitCode(error)).toBe(7);
				}
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

	it('keeps Ctrl-] handling consistent across chunk boundaries', () => {
		const sameChunk = parseAttachInput(
			{ awaitingEscape: false },
			Buffer.from('\u001dx'),
		);
		const first = parseAttachInput(
			{ awaitingEscape: false },
			Buffer.from('\u001d'),
		);
		const splitChunk = parseAttachInput(first.state, Buffer.from('x'));
		expect(splitChunk).toEqual(sameChunk);
		expect(sameChunk).toEqual({
			state: { awaitingEscape: false },
			actions: [{ _tag: 'input', data: 'x' }, { _tag: 'detach' }],
		});
	});

	it('forwards every byte before detaching after another key', () => {
		const first = parseAttachInput(
			{ awaitingEscape: false },
			Buffer.from('\u001d'),
		);
		expect(parseAttachInput(first.state, Buffer.from('xyz'))).toEqual({
			state: { awaitingEscape: false },
			actions: [{ _tag: 'input', data: 'xyz' }, { _tag: 'detach' }],
		});
	});

	it('preserves a UTF-8 code point split across input chunks', () => {
		const decoder = new StringDecoder('utf8');
		const bytes = Buffer.from('🦄');
		const first = parseAttachInput(
			{ awaitingEscape: false },
			bytes.subarray(0, 2),
			(chunk) => decoder.write(chunk),
		);
		expect(first.actions).toEqual([]);
		expect(
			parseAttachInput(first.state, bytes.subarray(2), (chunk) =>
				decoder.write(chunk),
			).actions,
		).toEqual([{ _tag: 'input', data: '🦄' }]);
	});

	it.effect('rejects a malformed daemon stream frame', () =>
		Effect.gen(function* () {
			const result = yield* Effect.exit(
				decodeDaemonStreamFrame('{"version":1,"event":"output"}'),
			);
			expect(result._tag).toBe('Failure');
		}),
	);
});
