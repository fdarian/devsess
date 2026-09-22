import { describe, expect, it } from '@effect/vitest';
import { Deferred, Effect, Exit } from 'effect';
import type { DaemonRequest } from '../../src/cli/protocol';
import type { RunRecord } from '../../src/cli/registry';
import {
	type DaemonError,
	makeRequestDispatcher,
} from '../../src/cli/request-dispatch';
import { runTest } from '../support/run-test';

const activeRun: RunRecord = {
	runId: 'run',
	projectName: 'project',
	presetName: 'dev',
	canonicalCwd: '/tmp',
	invocationCwd: '/tmp',
	configSnapshot: {},
	startedAt: '2026-09-22T00:00:00.000Z',
	state: 'running',
	daemon: { pid: 2, processGroupId: 2, startedAt: 'birth' },
	services: [
		{
			name: 'web',
			command: 'sleep 30',
			cwd: '/tmp',
			state: 'running',
		},
	],
};

const request = (
	method: 'info' | 'shutdown',
	params: Record<string, never> | { force: boolean } = {},
) =>
	({
		version: 1,
		requestId: method,
		method,
		params,
	}) as DaemonRequest;

const dispatcher = (runs: ReadonlyArray<RunRecord>) =>
	Effect.gen(function* () {
		const shutdown = yield* Deferred.make<void>();
		const runStop = {
			stopRun: () => Effect.succeed(activeRun),
			finishService: () => Effect.void,
			terminateRemaining: () => Effect.succeed(activeRun),
		};
		const value = makeRequestDispatcher({
			registry: {
				list: Effect.succeed(runs),
				get: () => Effect.succeed(activeRun),
				reserve: () => Effect.void,
				replace: () => Effect.succeed(activeRun),
			},
			terminals: new Map(),
			sockets: new Map(),
			output: {} as never,
			serviceState: {} as never,
			subscriptions: {} as never,
			runStart: {} as never,
			runStop,
			info: () => Effect.succeed({ pid: 42 }),
			requestShutdown: Deferred.succeed(shutdown, undefined),
			reply: () => Effect.void,
			fail: () => Effect.void,
		});
		return { shutdown, value };
	});

describe('daemon request dispatch', () => {
	it.effect('dispatches info and signals shutdown after replying', () =>
		runTest(
			Effect.scoped(
				Effect.gen(function* () {
					const configured = yield* dispatcher([]);
					const reply = yield* Deferred.make<unknown, DaemonError>();
					yield* configured.value.handleClient({
						_tag: 'request',
						incoming: request('info'),
						socket: undefined,
						reply,
					});
					expect(yield* Deferred.await(reply)).toEqual({ pid: 42 });

					const shutdownReply = yield* Deferred.make<unknown, DaemonError>();
					yield* configured.value.handleClient({
						_tag: 'request',
						incoming: request('shutdown'),
						socket: undefined,
						reply: shutdownReply,
					});
					expect(yield* Deferred.await(shutdownReply)).toEqual({});
					yield* Deferred.await(configured.shutdown);
				}),
			),
		),
	);

	it.effect('refuses graceful shutdown while a service is live', () =>
		runTest(
			Effect.scoped(
				Effect.gen(function* () {
					const configured = yield* dispatcher([activeRun]);
					const result = yield* Effect.exit(
						configured.value.processRequest(request('shutdown'), undefined),
					);
					expect(result._tag).toBe('Failure');
					if (Exit.isFailure(result))
						expect(String(result.cause)).toContain('project/dev');
				}),
			),
		),
	);
});
