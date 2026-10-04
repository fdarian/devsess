import { spawn } from 'node:child_process';
import {
	cp,
	mkdir,
	mkdtemp,
	readFile,
	rm,
	symlink,
	writeFile,
} from 'node:fs/promises';
import { createServer, Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { NodeServices } from '@effect/platform-node';
import { Effect, Schema } from 'effect';
import { expect, it } from 'vitest';
import { Service } from '../../src/services/index';
import { serveHost } from '../../src/services/shared/host';
import {
	acquireHost,
	hostPaths,
	launchHost,
	socketPath,
	startupLock,
} from '../../src/services/shared/protocol';
import { readSocketLine } from '../../src/socket-line';

const runChild = (file: string, args: string[] = [], env = process.env) =>
	new Promise<void>((resolve, reject) => {
		const child = spawn(process.execPath, [file, ...args], {
			env,
			stdio: ['ignore', 'ignore', 'pipe'],
		});
		let error = '';
		child.stderr.on('data', (chunk) => {
			error += chunk.toString();
		});
		child.once('error', reject);
		child.once('exit', (code) =>
			code === 0 ? resolve() : reject(new Error(error)),
		);
	});

it('waits beyond a minute for startup and lock contention without spawning another host', async () => {
	const root = await mkdtemp(join(tmpdir(), 'devsess-slow-'));
	const paths = hostPaths(join(root, '.data/sessions/test'), 'slow');
	const leases: import('../../src/services/shared/protocol').Lease[] = [];
	const launches = { count: 0 };
	const acquire = () =>
		Effect.runPromise(
			acquireHost(paths, async () => {
				launches.count++;
				return launchHost(paths, {
					module: new URL('./shared-slow-fixture.ts', import.meta.url).href,
					name: 'slow',
					root,
					session: 'test',
				});
			}),
		);
	try {
		leases.push(...(await Promise.all([acquire(), acquire()])));
		expect(launches.count).toBe(1);
		expect(leases[0]?.line).toBe(leases[1]?.line);
	} finally {
		for (const lease of leases) lease.socket.destroy();
		await new Promise((resolve) => setTimeout(resolve, 6_000));
		await rm(root, { recursive: true, force: true });
	}
}, 80_000);

it('fails with a bounded log tail if the host exits while a readiness connection is open', async () => {
	const root = await mkdtemp(join(tmpdir(), 'devsess-exit-'));
	const paths = hostPaths(root, 'exit');
	await mkdir(paths.dir, { recursive: true });
	try {
		const script = join(root, 'exit.ts');
		const address = await socketPath(paths);
		await writeFile(
			script,
			`import { createServer } from 'node:net';
import { writeFileSync } from 'node:fs';
writeFileSync(${JSON.stringify(paths.log)}, 'x'.repeat(20000) + 'startup failed at the end');
createServer(() => { setTimeout(() => process.exit(1), 100); }).listen(${JSON.stringify(address)});
`,
		);
		const result = await Effect.runPromise(
			acquireHost(paths, async () => {
				const child = spawn(process.execPath, [script], { stdio: 'ignore' });
				await new Promise<void>((resolve, reject) => {
					child.once('spawn', resolve);
					child.once('error', reject);
				});
				return child;
			}).pipe(Effect.flip),
		);
		expect(result.message).toContain('startup failed at the end');
		expect(result.message.length).toBeLessThan(8_300);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

it('decodes split UTF-8 and caps lines by bytes', async () => {
	const socket = new Socket();
	const reading = readSocketLine(socket);
	for (const byte of Buffer.from('hé😀\n'))
		socket.emit('data', Buffer.from([byte]));
	expect(await reading).toBe('hé😀');
	const capped = new Socket();
	const oversized = readSocketLine(capped, 3);
	capped.emit('data', Buffer.from('😀\n'));
	await expect(oversized).rejects.toThrow('byte limit');
	socket.destroy();
	capped.destroy();
});

it('preserves sticky-port entries written by concurrent processes', async () => {
	const root = await mkdtemp(join(tmpdir(), 'devsess-ports-'));
	try {
		const script = join(root, 'ports.ts');
		await symlink(
			fileURLToPath(new URL('../../node_modules', import.meta.url)),
			join(root, 'node_modules'),
		);
		await writeFile(
			script,
			`import { getStickyPort } from ${JSON.stringify(new URL('../../dist/index.js', import.meta.url).href)};
import { Effect } from 'effect';
import { NodeServices } from '@effect/platform-node';
const session = { name: 'test', lastModifiedAt: null, path: (relative) => Effect.succeed(${JSON.stringify(root)} + '/' + relative), toString: () => 'test' };
await Effect.runPromise(getStickyPort(session, { name: process.argv[2] }).pipe(Effect.provide(NodeServices.layer)));
`,
		);
		await Promise.all(
			Array.from({ length: 8 }, (_, index) =>
				runChild(script, [`port-${index}`]),
			),
		);
		const state = await Effect.runPromise(
			Schema.decodeUnknownEffect(
				Schema.fromJsonString(
					Schema.Struct({ ports: Schema.Record(Schema.String, Schema.Number) }),
				),
			)(await readFile(join(root, 'sess.json'), 'utf8')),
		);
		expect(Object.keys(state.ports)).toHaveLength(8);
		expect(new Set(Object.values(state.ports)).size).toBe(8);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

it('launches from a path with spaces, strips daemon env, and leaves handler dataDir empty', async () => {
	const root = await mkdtemp(join(tmpdir(), 'devsess space '));
	try {
		await cp(
			fileURLToPath(new URL('../../dist', import.meta.url)),
			join(root, 'dist'),
			{ recursive: true },
		);
		await symlink(
			fileURLToPath(new URL('../../node_modules', import.meta.url)),
			join(root, 'node_modules'),
		);
		const script = join(root, 'consumer.ts');
		await writeFile(
			script,
			`import { Service } from './dist/services/index.js';
import { Effect, Schema } from 'effect';
import { NodeServices } from '@effect/platform-node';
import { readdir, writeFile } from 'node:fs/promises';
export const service = Service.make({ name: 'space', shared: { output: Schema.Struct({ pid: Schema.Number }) }, start: (ctx) => Effect.acquireRelease(Effect.promise(async () => { const entries = await readdir(ctx.dataDir); const env = Object.keys(process.env).filter((key) => key.startsWith('DEVSESS_')); await writeFile(ctx.dataDir + '/result', JSON.stringify({ entries, env })); return { pid: process.pid }; }), () => Effect.promise(() => writeFile(ctx.dataDir + '/stopped', 'yes'))) });
if (process.argv[2] === 'consume') await Effect.runPromise(Effect.scoped(Service.run({ name: 'test', rootDir: ${JSON.stringify(root)}, lastModifiedAt: null, path: (relative) => Effect.succeed(${JSON.stringify(root)} + '/.data/sessions/test/' + relative), toString: () => 'test' }, service)).pipe(Effect.provide(NodeServices.layer)));
`,
		);
		await runChild(script, ['consume'], {
			...process.env,
			DEVSESS_TEST: 'must-not-inherit',
		});
		const dataDir = join(root, '.data/sessions/shared-services/services/space');
		const result = await Effect.runPromise(
			Schema.decodeUnknownEffect(
				Schema.fromJsonString(
					Schema.Struct({
						entries: Schema.Array(Schema.String),
						env: Schema.Array(Schema.String),
					}),
				),
			)(await readFile(join(dataDir, 'result'), 'utf8')),
		);
		expect(result).toEqual({ entries: [], env: [] });
		await new Promise((resolve) => setTimeout(resolve, 6_000));
		expect(await readFile(join(dataDir, 'stopped'), 'utf8')).toBe('yes');
	} finally {
		await rm(root, { recursive: true, force: true });
	}
}, 15_000);

it('retries a connection closed during teardown after waiting for the shutdown lock', async () => {
	const root = await mkdtemp(join(tmpdir(), 'devsess-drop-'));
	const paths = hostPaths(root, 'drop');
	await mkdir(paths.dir, { recursive: true });
	const address = await socketPath(paths);
	const server = createServer((socket) => socket.destroy());
	await new Promise<void>((resolve) => server.listen(address, resolve));
	const release = await Effect.runPromise(startupLock(paths));
	const host = { promise: undefined as Promise<void> | undefined };
	try {
		const acquiring = Effect.runPromise(
			acquireHost(paths, async () => {
				host.promise = Effect.runPromise(
					serveHost(paths, 'ready', Effect.void, 20),
				);
				return spawn(process.execPath, ['-e', 'setTimeout(() => {}, 1000)'], {
					stdio: 'ignore',
				});
			}),
		);
		await new Promise((resolve) => setTimeout(resolve, 100));
		await new Promise<void>((resolve) => server.close(() => resolve()));
		await release();
		const lease = await acquiring;
		expect(lease.line).toBe('ready');
		lease.socket.destroy();
		await host.promise;
	} finally {
		server.close();
		await rm(root, { recursive: true, force: true });
	}
});

it('closes its listener even when stop fails', async () => {
	const root = await mkdtemp(join(tmpdir(), 'devsess-stop-'));
	const paths = hostPaths(root, 'stop');
	await mkdir(paths.dir, { recursive: true });
	try {
		await expect(
			Effect.runPromise(
				serveHost(paths, 'ready', Effect.die('stop failed'), 20),
			),
		).rejects.toThrow('stop failed');
		const address = await socketPath(paths);
		const net = await import('node:net');
		const socket = net.connect(address);
		await expect(readSocketLine(socket)).rejects.toMatchObject({
			code: 'ENOENT',
		});
		socket.destroy();
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

it('parses the captured stack lazily as a typed ServiceError', async () => {
	const def = Service.make({
		name: 'bad-stack',
		shared: { output: Schema.Struct({}) },
		start: () => Effect.succeed({}),
	});
	const session = {
		name: 'test',
		lastModifiedAt: null,
		path: () => Effect.succeed('/unused'),
		toString: () => 'test',
	};
	await expect(
		Effect.runPromise(
			Service.run(session, { ...def, definitionStack: 'unparseable' }).pipe(
				Effect.scoped,
				Effect.provide(NodeServices.layer),
			),
		),
	).rejects.toMatchObject({
		_tag: 'ServiceError',
		message: expect.stringContaining('Unable to locate'),
	});
});
