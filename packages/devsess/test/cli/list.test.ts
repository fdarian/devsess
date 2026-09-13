import { describe, expect, it } from '@effect/vitest';
import { formatRunList } from '../../src/cli/commands/list';
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

describe('CLI list formatting', () => {
	it('omits exited runs and an empty elsewhere group', () => {
		const current = run('current', 'devsess', 'running');
		const exited = run('exited', 'old-project', 'exited');

		expect(
			formatRunList({ current: [current], runs: [current, exited] }),
		).toEqual(['Current project:', '  devsess/default running']);
	});

	it('keeps active runs grouped under elsewhere', () => {
		const current = run('current', 'devsess', 'running');
		const elsewhere = run('elsewhere', 'other-project', 'orphaned');

		expect(
			formatRunList({ current: [current], runs: [current, elsewhere] }),
		).toEqual([
			'Current project:',
			'  devsess/default running',
			'Elsewhere:',
			'  other-project/default orphaned',
		]);
	});
});
