import { NodeTerminal } from '@effect/platform-node';
import { describe, expect, it } from '@effect/vitest';
import { Effect, Layer } from 'effect';
import { Terminal } from 'effect/Terminal';
import { afterEach, vi } from 'vitest';
import { callDaemon } from '../../src/cli/client';
import { chooseRun, resolveCurrentRuns } from '../../src/cli/commands/daemon';
import { stop } from '../../src/cli/commands/stop';
import type { RunRecord } from '../../src/cli/registry';
import { STOP_REQUEST_TIMEOUT_MS } from '../../src/cli/termination';
import { runTest } from '../support/run-test';

vi.mock('../../src/cli/client', () => ({ callDaemon: vi.fn() }));
vi.mock('../../src/cli/commands/daemon', async (importOriginal) => {
	const actual =
		await importOriginal<typeof import('../../src/cli/commands/daemon')>();
	return {
		...actual,
		chooseRun: vi.fn(),
		resolveCurrentRuns: vi.fn(),
	};
});

afterEach(() => {
	vi.restoreAllMocks();
});

const run: RunRecord = {
	runId: 'run',
	projectName: 'project',
	presetName: 'dev',
	canonicalCwd: '/tmp',
	invocationCwd: '/tmp',
	configSnapshot: {},
	startedAt: '2026-09-09T00:00:00.000Z',
	state: 'running',
	daemon: { pid: 123, processGroupId: 123, startedAt: 'birth' },
	services: [
		{ name: 'web', command: 'sleep 30', cwd: '/tmp', state: 'running' },
	],
};

describe('stop command', () => {
	it.effect('allows both termination phases plus a margin for the RPC', () =>
		runTest(
			Effect.gen(function* () {
				vi.mocked(resolveCurrentRuns).mockReturnValue(
					Effect.succeed({
						location: { dataDirectory: '/tmp/data', socketPath: '/tmp/socket' },
						runs: [run],
						current: [run],
						local: [run],
					}),
				);
				vi.mocked(chooseRun).mockReturnValue(Effect.succeed(run));
				let timeout: number | undefined;
				vi.mocked(callDaemon).mockImplementation(
					(_socketPath, _request, timeoutMs) => {
						timeout = timeoutMs;
						return Effect.succeed(run);
					},
				);
				vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
				yield* stop({});
				expect(timeout).toBe(STOP_REQUEST_TIMEOUT_MS);
			}).pipe(
				Effect.provide(
					Layer.effect(
						Terminal,
						NodeTerminal.make(() => false),
					),
				),
			),
		),
	);
});
