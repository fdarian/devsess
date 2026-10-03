import { spawn } from 'node:child_process';
import {
	mkdir,
	mkdtemp,
	readFile,
	rm,
	stat,
	writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { NodeServices } from '@effect/platform-node';
import { Effect, Exit, Scope } from 'effect';
import { describe, expect, it } from 'vitest';
import { Service } from '../../src/services/index';
import {
	acquireHost,
	type Lease,
	launchHost,
} from '../../src/services/shared/protocol';
import { fixture } from './shared-fixture';
import { getPrivateService } from './shared-private-fixture';

const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const waitFor = async (predicate: () => Promise<boolean>) => {
	const deadline = Date.now() + 15_000;
	while (!(await predicate())) {
		if (Date.now() > deadline) throw new Error('Timed out');
		await pause(50);
	}
};

describe('shared host protocol (real detached processes)', () => {
	it('keeps the host alive until a slow finalizer with only unref’d resources completes', async () => {
		const root = await mkdtemp(join(tmpdir(), 'devsess-unref-'));
		const dir = join(root, 'services/unref');
		const child = spawn(
			process.execPath,
			[
				new URL('../../dist/services/shared/entry.js', import.meta.url)
					.pathname,
				new URL('./shared-unref-fixture.ts', import.meta.url).href,
				'unref',
				root,
			],
			{ stdio: 'ignore' },
		);
		const exited = new Promise<{
			code: number | null;
			signal: NodeJS.Signals | null;
		}>((resolve, reject) => {
			child.once('error', reject);
			child.once('exit', (code, signal) => resolve({ code, signal }));
		});
		try {
			const lease = await Effect.runPromise(acquireHost(dir, async () => {}));
			lease.socket.destroy();
			expect(await exited).toEqual({ code: 0, signal: null });
			expect(await readFile(join(dir, 'events'), 'utf8')).toBe(
				'stopping\nstop\n',
			);
			await expect(stat(join(dir, 'startup.lock'))).rejects.toMatchObject({
				code: 'ENOENT',
			});
		} finally {
			if (child.exitCode === null && child.signalCode === null)
				child.kill('SIGKILL');
			await exited;
			await rm(root, { recursive: true, force: true });
		}
	}, 15_000);
	it('Service.run imports the captured fixture and shares one fixed root session across projects', async () => {
		const root = await mkdtemp(join(tmpdir(), 'devsess-home-'));
		await writeFile(join(root, '.git'), 'gitdir: elsewhere');
		await writeFile(join(root, 'package.json'), '{}');
		for (const project of ['one', 'two']) {
			await mkdir(join(root, 'packages', project), { recursive: true });
			await writeFile(join(root, 'packages', project, 'package.json'), '{}');
		}
		const scopes = await Promise.all([
			Effect.runPromise(Scope.make()),
			Effect.runPromise(Scope.make()),
		]);
		try {
			const values = await Promise.all(
				scopes.map((scope, index) =>
					Effect.runPromise(
						Service.run(
							{
								name: `consumer-${index}`,
								lastModifiedAt: null,
								path: (relative) =>
									Effect.succeed(
										`${root}/packages/${index === 0 ? 'one' : 'two'}/.data/sessions/consumer-${index}/${relative}`,
									),
								toString: () => `consumer-${index}`,
							},
							fixture,
						).pipe(
							Effect.provideService(Scope.Scope, scope),
							Effect.provide(NodeServices.layer),
						),
					),
				),
			);
			expect(values[0]).toEqual(values[1]);
			expect(values[0]?.pid).toBeGreaterThan(0);
			expect(values[0]?.pid).not.toBe(process.pid);
			expect(values[0]?.ports.api).toBeGreaterThan(0);
			expect(
				await readFile(
					join(root, '.data/sessions/shared-services/services/fixture/events'),
					'utf8',
				),
			).toMatch(/^start /);
		} finally {
			await Promise.all(
				scopes.map((scope) => Effect.runPromise(Scope.close(scope, Exit.void))),
			);
			await pause(6_000);
			await rm(root, { recursive: true, force: true });
		}
	}, 15_000);
	it('clearly rejects a definition not exported by the captured file', async () => {
		const root = await mkdtemp(join(tmpdir(), 'devsess-private-'));
		try {
			const session = {
				name: 'consumer',
				lastModifiedAt: null,
				path: (relative: string) =>
					Effect.succeed(`${root}/.data/sessions/consumer/${relative}`),
				toString: () => 'consumer',
			};
			await expect(
				Effect.runPromise(
					Effect.scoped(Service.run(session, getPrivateService())).pipe(
						Effect.provide(NodeServices.layer),
					),
				),
			).rejects.toThrow(
				'export the shared service `private` from the file that calls Service.make',
			);
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	}, 10_000);
	it('concurrent consumers start one host, reuse it, and stop after the last lease plus grace', async () => {
		const root = await mkdtemp(join(tmpdir(), 'devsess-shared-'));
		const dir = join(root, 'services/fixture');
		const leases: Lease[] = [];
		const acquire = () =>
			Effect.runPromise(
				acquireHost(dir, () =>
					launchHost(dir, [
						new URL('./shared-fixture.ts', import.meta.url).href,
						'fixture',
						root,
					]),
				),
			);
		try {
			leases.push(...(await Promise.all([acquire(), acquire()])));
			expect(leases[0]?.line).toBe(leases[1]?.line);
			leases.push(await acquire());
			expect(
				(await readFile(join(dir, 'events'), 'utf8')).match(/start /g),
			).toHaveLength(1);
			leases[0]?.socket.destroy();
			leases[1]?.socket.destroy();
			await pause(5_200);
			expect(await readFile(join(dir, 'events'), 'utf8')).not.toContain('stop');
			leases[2]?.socket.destroy();
			await pause(200);
			expect(await stat(join(dir, 'host.sock'))).toBeDefined();
			await waitFor(async () =>
				(await readFile(join(dir, 'events'), 'utf8')).endsWith('stop\n'),
			);
		} finally {
			for (const lease of leases) lease.socket.destroy();
			await rm(root, { recursive: true, force: true });
		}
	}, 20_000);

	it('recovers a killed host socket and serializes restart with slow shutdown under the lock', async () => {
		const root = await mkdtemp(join(tmpdir(), 'devsess-shared-'));
		const dir = join(root, 'services/fixture');
		const leases: Lease[] = [];
		const acquire = () =>
			Effect.runPromise(
				acquireHost(dir, () =>
					launchHost(dir, [
						new URL('./shared-fixture.ts', import.meta.url).href,
						'fixture',
						root,
					]),
				),
			);
		try {
			const first = await acquire();
			leases.push(first);
			const pid = Number(first.line.match(/"pid":(\d+)/)?.[1]);
			expect(Number.isFinite(pid)).toBe(true);
			process.kill(pid, 'SIGKILL');
			await new Promise((resolve) => first.socket.once('close', resolve));
			expect(await stat(join(dir, 'host.sock'))).toBeDefined();
			const second = await acquire();
			leases.push(second);
			expect(second.line).not.toBe(first.line);
			second.socket.destroy();
			await waitFor(async () =>
				(await readFile(join(dir, 'events'), 'utf8')).includes('stopping'),
			);
			leases.push(...(await Promise.all([acquire(), acquire()])));
			expect(leases[2]?.line).toBe(leases[3]?.line);
			const events = await readFile(join(dir, 'events'), 'utf8');
			expect(events.match(/start /g)).toHaveLength(3);
			expect(events.indexOf('stop\n')).toBeLessThan(
				events.lastIndexOf('start '),
			);
			for (const lease of leases) lease.socket.destroy();
			await waitFor(async () =>
				(await readFile(join(dir, 'events'), 'utf8')).endsWith('stop\n'),
			);
		} finally {
			for (const lease of leases) lease.socket.destroy();
			await rm(root, { recursive: true, force: true });
		}
	}, 25_000);
});
