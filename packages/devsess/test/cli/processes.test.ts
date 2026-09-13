import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { describe, expect, it } from '@effect/vitest';
import { Effect } from 'effect';
import { afterEach, vi } from 'vitest';
import { Processes } from '../../src/cli/processes';

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
const fakeGroup = (termKillsGroup = true) => {
	const state = { leaderAlive: true, groupAlive: true };
	vi.mocked(execFile).mockImplementation((...args: Array<unknown>) => {
		const callback = args.at(-1);
		if (typeof callback !== 'function')
			throw new Error('Expected process inspection callback');
		if (state.leaderAlive)
			callback(null, ' 98765 Wed Sep 9 00:00:00 2026\n', '');
		else callback(Object.assign(new Error('missing'), { code: 1 }), '', '');
		return {} as ReturnType<typeof execFile>;
	});
	vi.mocked(readFile).mockImplementation(async () => {
		if (!state.leaderAlive)
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

	it.live(
		'escalates to SIGKILL while the recovered leader remains identifiable',
		() =>
			Effect.gen(function* () {
				vi.useFakeTimers();
				const group = fakeGroup(false);
				const processes = yield* Processes.make;
				const saved = yield* processes.capture(98765);
				const completion = Effect.runPromise(processes.terminate(saved, false));
				yield* Effect.promise(() => vi.runAllTimersAsync());
				yield* Effect.promise(() => completion);
				expect(group.kill).toHaveBeenCalledWith(-98765, 'SIGKILL');
				expect(group.state.groupAlive).toBe(false);
			}),
	);
});
