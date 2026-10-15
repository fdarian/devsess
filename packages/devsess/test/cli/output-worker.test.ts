import { describe, expect, it } from '@effect/vitest';
import { Effect } from 'effect';
import { vi } from 'vitest';
import { Logs } from '../../src/cli/logs';
import {
	MAX_OUTPUT_BACKLOG_BYTES,
	makeOutputWorker,
} from '../../src/cli/output-worker';
import { runTest } from '../support/run-test';

describe('output worker', () => {
	it.live('gives up waiting for a log append that never finishes', () =>
		runTest(
			Effect.scoped(
				Effect.gen(function* () {
					const append = vi.fn(() => Effect.never);
					const output = yield* makeOutputWorker({
						logs: Logs.of({
							append,
							replayAndSubscribe: () => Effect.never,
						}),
						onPersistenceFailure: () => undefined,
						idleTimeoutMs: 50,
					});
					const address = { runId: 'run', serviceName: 'web' };
					const terminal = { pause: vi.fn(), resume: vi.fn() } as never;
					yield* output.start(address, terminal);
					output.enqueue(address, terminal, 'hello');
					yield* Effect.sleep('20 millis');
					expect(append).toHaveBeenCalledTimes(1);
					const startedAt = Date.now();
					yield* output
						.awaitIdle(address, terminal)
						.pipe(Effect.timeout('2 seconds'));
					expect(Date.now() - startedAt).toBeLessThan(1_000);
				}),
			),
		),
	);

	it.live('stops pausing the terminal once backpressure is released', () =>
		runTest(
			Effect.scoped(
				Effect.gen(function* () {
					const output = yield* makeOutputWorker({
						logs: Logs.of({
							append: () => Effect.never,
							replayAndSubscribe: () => Effect.never,
						}),
						onPersistenceFailure: () => undefined,
					});
					const address = { runId: 'run', serviceName: 'web' };
					const pause = vi.fn();
					const resume = vi.fn();
					const terminal = { pause, resume } as never;
					const chunk = 'x'.repeat(MAX_OUTPUT_BACKLOG_BYTES + 1);
					yield* output.start(address, terminal);
					output.enqueue(address, terminal, chunk);
					expect(pause).toHaveBeenCalledTimes(1);
					yield* output.releaseBackpressure(address, terminal);
					expect(resume).toHaveBeenCalledTimes(1);
					output.enqueue(address, terminal, chunk);
					expect(pause).toHaveBeenCalledTimes(1);
				}),
			),
		),
	);
});
