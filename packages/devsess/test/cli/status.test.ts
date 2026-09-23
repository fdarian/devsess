import { describe, expect, it } from '@effect/vitest';
import { formatStatus } from '../../src/cli/commands/status';
import type { RunRecord } from '../../src/cli/registry';

const run = (
	runId: string,
	projectName: string,
	state: RunRecord['state'],
): RunRecord => ({
	runId,
	projectName,
	presetName: 'default',
	canonicalCwd: `/work/${projectName}`,
	invocationCwd: `/work/${projectName}`,
	configSnapshot: {},
	startedAt: '2026-09-12T00:00:00.000Z',
	state,
	daemon: {
		pid: 2,
		processGroupId: 2,
		startedAt: '2026-09-12T00:00:00.000Z',
	},
	services: [
		{
			name: 'web',
			command: 'bun run dev',
			cwd: `/work/${projectName}`,
			state,
		},
	],
});

describe('CLI status formatting', () => {
	it('omits exited runs and an empty elsewhere group', () => {
		const current = run('current', 'devsess', 'running');
		const exited = run('exited', 'old-project', 'exited');

		expect(
			formatStatus(
				[current, exited],
				false,
				Date.parse('2026-09-12T01:00:00.000Z'),
			),
		).toEqual([
			'devsess/default running [current]',
			'  Started: 2026-09-12T00:00:00.000Z',
			'  Uptime: 1h 0m',
			'  web: running — bun run dev (cwd: /work/devsess)',
		]);
	});

	it('shows active runs across projects', () => {
		const current = run('current', 'devsess', 'running');
		const elsewhere = run('elsewhere', 'other-project', 'orphaned');

		expect(
			formatStatus(
				[current, elsewhere],
				false,
				Date.parse('2026-09-12T01:00:00.000Z'),
			),
		).toContain('other-project/default running [elsewher]');
	});

	it('labels completed runs with --all and reports empty state', () => {
		const finished = {
			...run('finished', 'oagent', 'exited'),
			state: 'running' as const,
		};
		expect(formatStatus([finished], false)).toEqual([
			'Nothing running. See `devsess list` for available presets.',
		]);
		expect(formatStatus([finished], true)[0]).toBe(
			'oagent/default finished [finished]',
		);
	});

	it('shows service PID and exit code independently of the aggregate state', () => {
		const current = run('active-session', 'oagent', 'running');
		const visible: RunRecord = {
			...current,
			services: [
				{
					name: 'web',
					command: 'bun run dev',
					cwd: '/work/oagent',
					state: 'running',
					process: { pid: 123, processGroupId: 123, startedAt: 'birth' },
				},
				{
					name: 'worker',
					command: 'bun worker',
					cwd: '/work/oagent',
					state: 'exited',
					exitCode: 7,
				},
			],
		};
		const lines = formatStatus([visible], false);
		expect(lines).toContain(
			'  web: running pid 123 — bun run dev (cwd: /work/oagent)',
		);
		expect(lines).toContain(
			'  worker: exited exit 7 — bun worker (cwd: /work/oagent)',
		);
	});
});
