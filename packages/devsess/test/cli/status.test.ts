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
	it('renders published URLs, named URLs, and compact JSON while leaving unpublished services unchanged', () => {
		const current = run('ready-run', 'oagent', 'running');
		const web = current.services[0];
		if (web === undefined) return expect.fail('Missing service fixture');
		const publishedAt = '2026-09-23T00:00:00.000Z';
		const visible: RunRecord = {
			...current,
			services: [
				{
					...web,
					process: { pid: 123, processGroupId: 123, startedAt: 'birth' },
					published: { value: { url: 'http://localhost:5173' }, publishedAt },
				},
				{
					...web,
					name: 'api',
					published: {
						value: {
							urls: {
								app: 'http://localhost:5173',
								api: 'http://localhost:3000',
							},
						},
						publishedAt,
					},
				},
				{
					...web,
					name: 'worker',
					published: { value: { detail: 'x'.repeat(200) }, publishedAt },
				},
				{ ...web, name: 'db' },
			],
		};
		const lines = formatStatus([visible], false);
		expect(lines).toContain(
			'  web: running ready pid 123 — bun run dev (cwd: /work/oagent) — http://localhost:5173',
		);
		expect(lines).toContain(
			'  api: running ready — bun run dev (cwd: /work/oagent) — app=http://localhost:5173, api=http://localhost:3000',
		);
		expect(lines.find((line) => line.includes('worker:'))).toMatch(
			/running ready.* — \{"detail":"x+…$/,
		);
		expect(lines).toContain('  db: running — bun run dev (cwd: /work/oagent)');
	});
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
		expect(
			formatStatus(
				[finished],
				false,
				Date.parse('2026-09-12T00:02:00.000Z'),
				'/work/oagent',
			),
		).toEqual([
			'Nothing running. See `devsess list` for available presets.',
			'Last run: oagent/default [finished] finished (started 2m 0s ago) — web exit unknown. See: devsess tail oagent/default --run finished',
		]);
		expect(formatStatus([finished], true)[0]).toBe(
			'oagent/default finished [finished]',
		);
	});

	it('prefers the latest finished run in the current project and labels legacy failed/zero records correctly', () => {
		const elsewhere = {
			...run('newer', 'other', 'failed'),
			startedAt: '2026-09-12T00:01:00.000Z',
		};
		const local = {
			...run('local', 'oagent', 'failed'),
			services: [
				{
					name: 'web',
					command: 'bun dev',
					cwd: '/work/oagent',
					state: 'failed' as const,
					exitCode: 0,
				},
			],
		};
		expect(
			formatStatus(
				[elsewhere, local],
				false,
				Date.parse('2026-09-12T00:02:00.000Z'),
				'/work/oagent',
			)[1],
		).toContain('Last run: oagent/default [local]');
		expect(formatStatus([local], true)).toContain(
			'  web: exited exit 0 — bun dev (cwd: /work/oagent)',
		);
		const web = local.services[0];
		if (web === undefined) return expect.fail('Missing service fixture');
		const signaled = { ...local, services: [{ ...web, signal: 15 }] };
		expect(formatStatus([signaled], true)).toContain(
			'  web: failed exit 143 (signal 15) — bun dev (cwd: /work/oagent)',
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
