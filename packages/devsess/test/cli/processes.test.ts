import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { describe, expect, it } from '@effect/vitest';
import { Effect } from 'effect';
import { afterEach, vi } from 'vitest';
import {
	descendantProcesses,
	makeProcessSampler,
	Processes,
	parseProcessTree,
} from '../../src/cli/processes';

vi.mock('node:child_process', async (importOriginal) => {
	const actual = await importOriginal<typeof import('node:child_process')>();
	return { ...actual, execFile: vi.fn(actual.execFile) };
});
vi.mock('node:fs/promises', async (importOriginal) => {
	const actual = await importOriginal<typeof import('node:fs/promises')>();
	return { ...actual, readFile: vi.fn(actual.readFile) };
});
afterEach(() => {
	vi.restoreAllMocks();
	vi.useRealTimers();
});

const missing = () =>
	Object.assign(new Error('No such process'), { code: 'ESRCH' });
const fakeGroup = (
	termKillsGroup = true,
	escaped = false,
	omitTree = false,
) => {
	const state = {
		leaderAlive: true,
		groupAlive: true,
		childStart: 'Wed Sep  9 00:00:00 2026',
	};
	vi.mocked(execFile).mockImplementation((...args: Array<unknown>) => {
		const commandArgs = args[1];
		const callback = args.at(-1);
		if (!Array.isArray(commandArgs) || typeof callback !== 'function')
			throw new Error('Expected process inspection callback');
		if (commandArgs[0] === '-A') {
			callback(
				null,
				omitTree
					? ''
					: `${state.groupAlive ? ' 98765 1 98765 S Wed Sep  9 00:00:00 2026\n 98766 98765 98765 S Wed Sep  9 00:00:00 2026\n' : ''}${escaped ? ` 99999 98765 99999 S ${state.childStart}\n` : ''}`,
				'',
			);
			return {} as ReturnType<typeof execFile>;
		}
		if (commandArgs[0] === '-g') {
			if (state.groupAlive) callback(null, ' 98765\n', '');
			else callback(Object.assign(new Error('missing'), { code: 1 }), '', '');
			return {} as ReturnType<typeof execFile>;
		}
		if (commandArgs[1] === 'pid=,ppid=,pgid=,stat=,lstart=') {
			if (commandArgs.at(-1) === '99999' && escaped)
				callback(null, ` 99999 98765 99999 S ${state.childStart}\n`, '');
			else if (commandArgs.at(-1) === '98766' && state.groupAlive)
				callback(null, ' 98766 98765 98765 S Wed Sep  9 00:00:00 2026\n', '');
			else if (state.leaderAlive)
				callback(null, ' 98765 1 98765 S Wed Sep  9 00:00:00 2026\n', '');
			else callback(Object.assign(new Error('missing'), { code: 1 }), '', '');
			return {} as ReturnType<typeof execFile>;
		}
		if (commandArgs.at(-1) === '99999' && escaped)
			callback(null, ` S 99999 ${state.childStart}\n`, '');
		else if (commandArgs.at(-1) === '98766' && state.groupAlive)
			callback(null, ' S 98765 Wed Sep 9 00:00:00 2026\n', '');
		else if (state.leaderAlive)
			callback(null, ' S 98765 Wed Sep 9 00:00:00 2026\n', '');
		else callback(Object.assign(new Error('missing'), { code: 1 }), '', '');
		return {} as ReturnType<typeof execFile>;
	});
	vi.mocked(readFile).mockImplementation(async (path) => {
		if (String(path).includes('/99999/') && escaped) {
			const fields = Array.from({ length: 20 }, () => '0');
			fields[2] = '99999';
			fields[19] = state.childStart;
			return `99999 (child) ${fields.join(' ')}`;
		}
		if (
			String(path).includes('/98766/') ? !state.groupAlive : !state.leaderAlive
		)
			throw Object.assign(new Error('missing'), { code: 'ENOENT' });
		const fields = Array.from({ length: 20 }, () => '0');
		fields[2] = '98765';
		fields[19] = 'birth';
		return `98765 (shell) ${fields.join(' ')}`;
	});
	const kill = vi.spyOn(process, 'kill').mockImplementation((_pid, signal) => {
		if (!state.groupAlive) throw missing();
		if (signal === 'SIGTERM' && termKillsGroup) state.groupAlive = false;
		if (signal === 'SIGKILL') state.groupAlive = false;
		return true;
	});
	return { state, kill };
};

describe('live process group ownership', () => {
	it.live(
		'signals a captured leader even when the tree sampler missed it',
		() =>
			Effect.gen(function* () {
				const group = fakeGroup(true, false, true);
				const processes = yield* Processes.make;
				const owned = yield* processes.captureLive(98765);
				yield* owned.terminate;
				expect(group.kill).toHaveBeenCalledWith(-98765, 'SIGTERM');
				expect(group.state.groupAlive).toBe(false);
			}),
	);
	it.effect('reads one process tree per sample across multiple services', () =>
		Effect.gen(function* () {
			const read = vi.fn(() =>
				Effect.succeed(
					parseProcessTree(' 101 1 101 S Wed Sep  9 00:00:00 2026\n'),
				),
			);
			const sampler = makeProcessSampler(read);
			const first = vi.fn();
			const second = vi.fn();
			const unregisterFirst = sampler.register(first);
			const unregisterSecond = sampler.register(second);
			yield* sampler.sample;
			yield* sampler.sample;
			expect(read).toHaveBeenCalledTimes(2);
			expect(first).toHaveBeenCalledTimes(2);
			expect(second).toHaveBeenCalledTimes(2);
			unregisterFirst();
			unregisterSecond();
		}),
	);
	it('collects nested escaped groups from the leader, group members, and tracked children', () => {
		const tree = parseProcessTree(`
  101 1 101 S Wed Sep  9 00:00:00 2026
  102 101 101 S Wed Sep  9 00:00:00 2026
  103 102 103 S Wed Sep  9 00:00:00 2026
  104 103 104 S Wed Sep  9 00:00:00 2026
  105 1 105 S Wed Sep  9 00:00:00 2026
  106 105 106 S Wed Sep  9 00:00:00 2026
  107 999 101 S Wed Sep  9 00:00:00 2026
  108 107 108 S Wed Sep  9 00:00:00 2026
  109 108 109 Z Wed Sep  9 00:00:00 2026
  malformed line
`);
		expect(tree).toHaveLength(8);
		const identity = { pid: 101, processGroupId: 101, startedAt: 'birth' };
		expect(
			descendantProcesses(tree, identity).map((process) => process.pid),
		).toEqual([103, 104, 108]);
		expect(
			descendantProcesses(tree, identity, new Set([105])).map(
				(process) => process.pid,
			),
		).toEqual([103, 104, 105, 106, 108]);
	});
	it.live(
		'cleans surviving descendants after leader exit and permanently expires on group disappearance',
		() =>
			Effect.gen(function* () {
				const group = fakeGroup();
				const processes = yield* Processes.make;
				const owned = yield* processes.captureLive(98765);
				group.state.leaderAlive = false;
				expect(yield* processes.owns(owned.identity)).toBe(false);
				yield* owned.terminate;
				expect(group.kill).toHaveBeenCalledWith(-98765, 'SIGTERM');
				expect(group.state.groupAlive).toBe(false);
				const calls = group.kill.mock.calls.length;
				group.state.groupAlive = true;
				yield* owned.terminate;
				expect(group.kill.mock.calls.length).toBe(calls);
			}),
	);

	it.live('confirms a group after a transient EPERM from kill zero', () =>
		Effect.gen(function* () {
			const group = fakeGroup();
			let transient = true;
			group.kill.mockImplementation((_pid, signal) => {
				if (signal === 0 && transient) {
					transient = false;
					throw Object.assign(new Error('operation not permitted'), {
						code: 'EPERM',
					});
				}
				if (!group.state.groupAlive) throw missing();
				if (signal === 'SIGTERM') group.state.groupAlive = false;
				return true;
			});
			const processes = yield* Processes.make;
			const saved = yield* processes.capture(98765);
			yield* processes.terminate(saved, false);
			expect(group.kill).toHaveBeenCalledWith(-98765, 'SIGTERM');
			expect(vi.mocked(execFile)).toHaveBeenCalledWith(
				'ps',
				['-g', '98765', '-o', 'pid='],
				{ timeout: 500 },
				expect.any(Function),
			);
		}),
	);

	it.live('bounds ps fallback checks by elapsed time', () =>
		Effect.gen(function* () {
			vi.useFakeTimers();
			const group = fakeGroup();
			group.kill.mockImplementation((_pid, signal) => {
				if (signal === 0)
					throw Object.assign(new Error('operation not permitted'), {
						code: 'EPERM',
					});
				if (!group.state.groupAlive) throw missing();
				return true;
			});
			const processes = yield* Processes.make;
			vi.clearAllMocks();
			expect(yield* processes.groupAlive(98765)).toBe(true);
			const groupPsCalls = () =>
				vi
					.mocked(execFile)
					.mock.calls.filter(
						(call) => Array.isArray(call[1]) && call[1][0] === '-g',
					).length;
			expect(groupPsCalls()).toBe(1);
			vi.advanceTimersByTime(300);
			expect(yield* processes.groupAlive(98765)).toBe(true);
			expect(groupPsCalls()).toBe(1);
			vi.advanceTimersByTime(250);
			expect(yield* processes.groupAlive(98765)).toBe(true);
			expect(groupPsCalls()).toBe(2);
		}),
	);

	it.live('refuses to signal a recovered group after its leader exits', () =>
		Effect.gen(function* () {
			const group = fakeGroup();
			const processes = yield* Processes.make;
			const saved = yield* processes.capture(98765);
			group.state.leaderAlive = false;
			const result = yield* Effect.exit(processes.terminate(saved, false));
			expect(result._tag).toBe('Failure');
			expect(group.kill).toHaveBeenCalledWith(-98765, 0);
			expect(group.kill).not.toHaveBeenCalledWith(-98765, 'SIGTERM');
			expect(group.kill).not.toHaveBeenCalledWith(-98765, 'SIGKILL');
		}),
	);

	it.live('force signals a recovered group after its leader exits', () =>
		Effect.gen(function* () {
			const group = fakeGroup();
			const processes = yield* Processes.make;
			const saved = yield* processes.capture(98765);
			group.state.leaderAlive = false;
			yield* processes.terminate(saved, true);
			expect(group.kill).toHaveBeenCalledWith(-98765, 'SIGTERM');
			expect(group.state.groupAlive).toBe(false);
		}),
	);
	it.live('does not signal a descendant whose PID has been reused', () =>
		Effect.gen(function* () {
			const group = fakeGroup(true, true);
			const processes = yield* Processes.make;
			const owned = yield* processes.captureLive(98765);
			group.state.childStart = 'Thu Sep 10 00:00:00 2026';
			yield* owned.terminate;
			expect(group.kill).not.toHaveBeenCalledWith(99999, 'SIGTERM');
			expect(group.kill).not.toHaveBeenCalledWith(99999, 'SIGKILL');
		}),
	);

	it.live('does not signal an invalid recovered process group', () =>
		Effect.gen(function* () {
			const group = fakeGroup();
			const processes = yield* Processes.make;
			expect(yield* processes.groupAlive(0)).toBe(false);
			expect(group.kill).not.toHaveBeenCalled();
		}),
	);

	it.live('force still refuses an invalid recovered process group', () =>
		Effect.gen(function* () {
			const group = fakeGroup();
			const processes = yield* Processes.make;
			const result = yield* Effect.exit(
				processes.terminate(
					{ pid: 98765, processGroupId: 1, startedAt: 'birth' },
					true,
				),
			);
			expect(result._tag).toBe('Failure');
			expect(group.kill).not.toHaveBeenCalled();
		}),
	);

	it.live('reports SIGKILL for a SIGTERM-ignoring service', () =>
		Effect.gen(function* () {
			vi.useFakeTimers();
			const group = fakeGroup(false);
			const processes = yield* Processes.make;
			const saved = yield* processes.capture(98765);
			const completion = Effect.runPromise(processes.terminate(saved, false));
			yield* Effect.promise(() => vi.runAllTimersAsync());
			expect(yield* Effect.promise(() => completion)).toBe(9);
			expect(group.kill).toHaveBeenCalledWith(-98765, 'SIGKILL');
			expect(group.state.groupAlive).toBe(false);
		}),
	);
});
