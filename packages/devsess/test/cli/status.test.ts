import { describe, expect, it } from '@effect/vitest';
import { formatService, formatStatus } from '../../src/cli/commands/status';
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
	it('shows unambiguous short IDs across active and finished runs', () => {
		const current = run(
			'c585f251-a000-0000-0000-000000000000',
			'mockingbird',
			'running',
		);
		const old = run('c585f251-b000-0000-0000-000000000000', 'other', 'exited');
		expect(formatStatus([current, old], false)[0]).toBe(
			'mockingbird/default running [c585f251-a]',
		);
		const all = formatStatus([current, old], true, Date.now(), undefined, [
			current,
			old,
		]);
		expect(all).toContain('mockingbird/default running [c585f251-a]');
		expect(all).not.toContain('other/default');
		const onlyFinished = formatStatus([old], false, Date.now(), '/work/other', [
			current,
			old,
		]);
		expect(onlyFinished[1]).toContain('Last run: other/default [c585f251-b]');
		expect(onlyFinished[1]).toContain('devsess tail c585f251-b');
	});
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

	it('keeps the last-run summary in --all mode when nothing is active', () => {
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
			'Last run: oagent/default [finished] finished (started 2m 0s ago) — web exit unknown. See: devsess tail finished',
		]);
		expect(formatStatus([], true)).toEqual([
			'Nothing running. See `devsess list` for available presets.',
		]);
		expect(
			formatStatus(
				[finished],
				true,
				Date.parse('2026-09-12T00:02:00.000Z'),
				'/work/oagent',
			),
		).toEqual([
			'Nothing running. See `devsess list` for available presets.',
			'Last run: oagent/default [finished] finished (started 2m 0s ago) — web exit unknown. See: devsess tail finished',
		]);
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
		const web = local.services[0];
		if (web === undefined) return expect.fail('Missing service fixture');
		expect(formatService(web)).toBe(
			'  web: exited exit 0 — bun dev (cwd: /work/oagent)',
		);
		const signaled = { ...local, services: [{ ...web, signal: 15 }] };
		const signaledService = signaled.services[0];
		if (signaledService === undefined)
			return expect.fail('Missing signaled service fixture');
		expect(formatService(signaledService)).toBe(
			'  web: failed exit 143 (signal 15) — bun dev (cwd: /work/oagent)',
		);
	});

	it('details the current project and summarizes other running projects', () => {
		const local = run('local-run', 'oagent', 'running');
		const other = run('other-run', 'mockingbird', 'running');
		const now = Date.parse('2026-09-12T00:05:00.000Z');
		expect(formatStatus([local, other], false, now, '/work/oagent')).toEqual([
			'oagent/default running [local-ru]',
			'  Started: 2026-09-12T00:00:00.000Z',
			'  Uptime: 5m 0s',
			'  web: running — bun run dev (cwd: /work/oagent)',
			'mockingbird/default running [other-ru] — up 5m 0s, 1 service',
			'Other projects are summarized. See `devsess status -a` for details.',
		]);
		expect(formatStatus([local, other], true, now, '/work/oagent')).toContain(
			'  web: running — bun run dev (cwd: /work/mockingbird)',
		);
		const finished = run('finished-run', 'finished-project', 'exited');
		const allActive = formatStatus(
			[local, other, finished],
			true,
			now,
			'/work/oagent',
		);
		expect(allActive).toContain('oagent/default running [local-ru]');
		expect(allActive).toContain('mockingbird/default running [other-ru]');
		expect(allActive).not.toContain('finished-project');
		expect(allActive).not.toContain('Other projects are summarized');
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
