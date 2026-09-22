import { describe, expect, it } from '@effect/vitest';
import { Effect } from 'effect';
import {
	decodeRequest,
	decodeRequestId,
	decodeResponse,
} from '../../src/cli/protocol';

describe('CLI protocol validation', () => {
	it.effect('rejects empty and unsafe request identifiers', () =>
		Effect.gen(function* () {
			const invalidRequests = [
				{
					version: 1,
					requestId: '',
					method: 'listRuns',
					params: {},
				},
				{
					version: 1,
					requestId: 'request',
					method: 'stopRun',
					params: { runId: '../../escape' },
				},
				{
					version: 1,
					requestId: 'request',
					method: 'tail',
					params: { runId: 'run', serviceName: '' },
				},
			];
			for (const request of invalidRequests) {
				const exit = yield* Effect.exit(decodeRequest(JSON.stringify(request)));
				expect(exit._tag).toBe('Failure');
			}
		}),
	);

	it.effect(
		'recovers a valid request id from an otherwise malformed frame',
		() =>
			Effect.gen(function* () {
				const request = yield* decodeRequestId(
					JSON.stringify({ requestId: 'request', method: 'unknown' }),
				);
				expect(request.requestId).toBe('request');
			}),
	);

	it.effect('rejects unsafe response identifiers too', () =>
		Effect.gen(function* () {
			const exit = yield* Effect.exit(
				decodeResponse(
					JSON.stringify({
						version: 1,
						requestId: '../escape',
						ok: false,
						error: 'invalid',
					}),
				),
			);
			expect(exit._tag).toBe('Failure');
		}),
	);

	it.effect('accepts additive daemon info and shutdown requests', () =>
		Effect.gen(function* () {
			const info = yield* decodeRequest(
				JSON.stringify({
					version: 1,
					requestId: 'info',
					method: 'info',
					params: {},
				}),
			);
			const shutdown = yield* decodeRequest(
				JSON.stringify({
					version: 1,
					requestId: 'shutdown',
					method: 'shutdown',
					params: { force: true },
				}),
			);
			expect(info.method).toBe('info');
			expect(shutdown.method).toBe('shutdown');
		}),
	);
});
