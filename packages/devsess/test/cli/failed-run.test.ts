import { describe, expect, it } from '@effect/vitest';
import { Effect, Queue } from 'effect';
import { afterEach, vi } from 'vitest';
import { callDaemon } from '../../src/cli/client';
import { finishedAttachError } from '../../src/cli/commands/attach';
import {
	formatStartFailure,
	isFailure,
	recentOutput,
	unpublishedExits,
	watchStart,
} from '../../src/cli/commands/start';
import type { RunRecord } from '../../src/cli/registry';
import {
	type DaemonStreamFrame,
	openDaemonStream,
} from '../../src/cli/terminal';
import { runTest } from '../support/run-test';

vi.mock('../../src/cli/terminal', () => ({ openDaemonStream: vi.fn() }));
vi.mock('../../src/cli/client', () => ({ callDaemon: vi.fn() }));

afterEach(() => {
	vi.restoreAllMocks();
	vi.mocked(callDaemon).mockReset();
});

const run: RunRecord = {
	runId: 'failed-run',
	projectName: 'mockingbird',
	presetName: 'default',
	canonicalCwd: '/work/mock',
	invocationCwd: '/work/mock',
	configSnapshot: {},
	startedAt: '2026-09-23T00:00:00.000Z',
	state: 'failed',
	daemon: { pid: 42, processGroupId: 42, startedAt: 'birth' },
	services: [
		{
			name: 'web',
			command: 'exit 1',
			cwd: '/work/mock',
			state: 'failed',
			exitCode: 1,
		},
		{
			name: 'engine',
			command: 'exit 1',
			cwd: '/work/mock',
			state: 'failed',
			exitCode: 1,
		},
	],
};

describe('failed run diagnostics', () => {
	it.live(
		'waits only for included services and reports readiness as it arrives',
		() =>
			runTest(
				Effect.gen(function* () {
					const initial: RunRecord = {
						...run,
						state: 'running',
						services: [
							{
								name: 'web',
								command: 'exit 1',
								cwd: '/work/mock',
								state: 'running',
							},
							{
								name: 'db',
								command: 'sleep 30',
								cwd: '/work/mock',
								state: 'running',
							},
						],
					};
					const ready: RunRecord = {
						...initial,
						services: initial.services.map((service) =>
							service.name === 'web'
								? {
										...service,
										published: {
											value: { url: 'http://localhost:5173' },
											publishedAt: new Date().toISOString(),
										},
									}
								: service,
						),
					};
					vi.mocked(callDaemon).mockReturnValue(
						Effect.succeed([ready]) as never,
					);
					const output = vi
						.spyOn(process.stdout, 'write')
						.mockImplementation(() => true);
					const result = yield* watchStart(
						'/tmp/isolated.sock',
						initial,
						new Set(['web']),
					).pipe(Effect.timeout('2 seconds'));
					expect(result.seen.has('web')).toBe(true);
					expect(result.seen.has('db')).toBe(false);
					expect(output).toHaveBeenCalledWith(
						'web ready → http://localhost:5173\n',
					);
				}),
			),
	);

	it.live(
		'stops waiting when an included service exits before publishing',
		() =>
			runTest(
				Effect.gen(function* () {
					const initial: RunRecord = {
						...run,
						state: 'running',
						services: [
							{
								name: 'web',
								command: 'exit 1',
								cwd: '/work/mock',
								state: 'running',
							},
						],
					};
					const exited: RunRecord = {
						...initial,
						state: 'exited',
						services: [
							{
								name: 'web',
								command: 'exit 0',
								cwd: '/work/mock',
								state: 'exited',
								exitCode: 0,
							},
						],
					};
					vi.mocked(callDaemon).mockReturnValue(
						Effect.succeed([exited]) as never,
					);
					const result = yield* watchStart(
						'/tmp/isolated.sock',
						initial,
						new Set(['web']),
					).pipe(Effect.timeout('2 seconds'));
					expect(
						unpublishedExits(result.run, new Set(['web']), result.seen).map(
							(service) => service.name,
						),
					).toEqual(['web']);
					expect(result.run.services[0]?.exitCode).toBe(0);
				}),
			),
	);
	it.live(
		'replays only the last ten output lines and preserves the saved exit',
		() =>
			runTest(
				Effect.gen(function* () {
					const frames = yield* Queue.unbounded<DaemonStreamFrame>();
					yield* Queue.offer(frames, {
						_tag: 'response',
						value: { version: 1, requestId: 'request', ok: true, result: {} },
					});
					yield* Queue.offer(frames, {
						_tag: 'output',
						value: {
							version: 1,
							requestId: 'request',
							event: 'output',
							data: Array.from(
								{ length: 12 },
								(_, index) => `line ${index}\n`,
							).join(''),
							offset: 100,
						},
					});
					yield* Queue.offer(frames, {
						_tag: 'output',
						value: {
							version: 1,
							requestId: 'request',
							event: 'exit',
							exitCode: 1,
						},
					});
					vi.mocked(openDaemonStream).mockReturnValue(
						Effect.succeed({ frames }) as never,
					);
					const service = run.services[0];
					if (service === undefined)
						return yield* Effect.die('Missing web service');
					const lines = yield* recentOutput('/tmp/isolated.sock', run, service);
					expect(lines).toHaveLength(10);
					expect(lines[0]).toBe('line 2');
					expect(lines[9]).toBe('line 11');
					expect(formatStartFailure(run, service, lines)).toContain(
						'devsess tail failed-r --service web',
					);
					expect(
						vi.mocked(openDaemonStream).mock.calls[0]?.[0].request.method,
					).toBe('tail');
				}),
			),
	);

	it('fails a start only when every service failed', () => {
		const web = run.services[0];
		const engine = run.services[1];
		if (web === undefined || engine === undefined)
			return expect.fail('Missing service fixtures');
		expect(run.services.every(isFailure)).toBe(true);
		expect(
			[{ ...web, state: 'running' as const }, engine].every(isFailure),
		).toBe(false);
		expect(isFailure({ ...web, state: 'exited', exitCode: 0 })).toBe(false);
	});

	it('explains finished attachments with each exit status and exact tail command', () => {
		const message = finishedAttachError(run, { service: 'web' }).message;
		expect(message).toContain('web: failed (exit 1)');
		expect(message).toContain('devsess tail failed-r --service web');
		expect(message).not.toContain('engine:');
	});
});
