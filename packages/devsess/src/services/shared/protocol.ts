import { type ChildProcess, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, open, readFile, readlink, rm, symlink } from 'node:fs/promises';
import { connect, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Effect, Schedule } from 'effect';
import lockfile from 'proper-lockfile';
import { ServiceError } from '../core';

export const sharedGraceMs = 5_000;

export const io = <A>(operation: () => Promise<A>) =>
	Effect.tryPromise({
		try: () => operation(),
		catch: (cause) =>
			new ServiceError({ message: 'Shared service protocol failed', cause }),
	});

export const startupLock = (dataDir: string) =>
	io(() =>
		lockfile.lock(dataDir, {
			realpath: false,
			lockfilePath: join(dataDir, 'startup.lock'),
			stale: 60_000,
			retries: { retries: 600, minTimeout: 50, maxTimeout: 100 },
		}),
	);

export type Lease = { socket: Socket; line: string };

/** Unix sockets have tiny pathname limits; a short directory alias keeps the socket in dataDir. */
export const socketPath = async (dataDir: string) => {
	const direct = join(dataDir, 'host.sock');
	if (Buffer.byteLength(direct) < 100) return direct;
	const alias = join(
		tmpdir(),
		`dvs-${createHash('sha256').update(dataDir).digest('hex').slice(0, 16)}`,
	);
	await symlink(dataDir, alias).catch(async (cause: unknown) => {
		if (
			typeof cause !== 'object' ||
			cause === null ||
			!('code' in cause) ||
			cause.code !== 'EEXIST'
		)
			throw cause;
		if ((await readlink(alias)) !== dataDir)
			throw new Error(`Unexpected shared socket alias: ${alias}`);
	});
	return join(alias, 'host.sock');
};

const connectSocket = (address: string): Promise<Lease> =>
	new Promise((resolve, reject) => {
		const socket = connect(address);
		const timer = setTimeout(
			() => socket.destroy(new Error('Shared host readiness timed out')),
			60_000,
		);
		let buffer = '';
		const fail = (cause: Error) => {
			clearTimeout(timer);
			socket.destroy();
			reject(cause);
		};
		socket.once('error', fail);
		socket.once('close', () =>
			fail(new Error('Shared host closed before readiness')),
		);
		socket.on('data', (chunk) => {
			buffer += chunk.toString();
			if (buffer.length > 1_048_576)
				return fail(new Error('Shared output exceeds 1 MiB'));
			const newline = buffer.indexOf('\n');
			if (newline < 0) return;
			clearTimeout(timer);
			socket.removeAllListeners('data');
			socket.removeListener('error', fail);
			socket.on('error', () => socket.destroy());
			resolve({ socket, line: buffer.slice(0, newline) });
		});
	});

export const connectHost = async (dataDir: string) =>
	connectSocket(await socketPath(dataDir));

const unavailable = (cause: unknown) =>
	typeof cause === 'object' &&
	cause !== null &&
	'code' in cause &&
	(cause.code === 'ENOENT' || cause.code === 'ECONNREFUSED');

type Launch = () => Promise<void> | Promise<ChildProcess>;

const startHost = (dataDir: string, launch: Launch) =>
	Effect.gen(function* () {
		yield* io(() => rm(join(dataDir, 'host.sock'), { force: true }));
		const child = yield* io(() =>
			launch().then((child) => (child === undefined ? undefined : child)),
		);
		const deadline = Date.now() + 60_000;
		return yield* Effect.suspend(() => {
			if (
				child !== undefined &&
				(child.exitCode !== null || child.signalCode !== null)
			)
				return io(() => readFile(join(dataDir, 'service.log'), 'utf8')).pipe(
					Effect.flatMap(
						(log) =>
							new ServiceError({
								message: `Shared host failed to start: ${log}`,
							}),
					),
				);
			return io(() => connectHost(dataDir));
		}).pipe(
			Effect.retry({
				while: (error) => unavailable(error.cause) && Date.now() < deadline,
				schedule: Schedule.spaced('50 millis'),
			}),
		);
	});

const acquireHostUnderLock = (dataDir: string, launch: Launch) =>
	Effect.gen(function* () {
		yield* Effect.acquireRelease(startupLock(dataDir), (release) =>
			io(release).pipe(Effect.orDie),
		);
		return yield* io(() => connectHost(dataDir)).pipe(
			Effect.catch((error) =>
				unavailable(error.cause) ? startHost(dataDir, launch) : error,
			),
		);
	}).pipe(Effect.scoped);

export const acquireHost = (dataDir: string, launch: Launch) =>
	Effect.gen(function* () {
		yield* io(() => mkdir(dataDir, { recursive: true }));
		return yield* io(() => connectHost(dataDir)).pipe(
			Effect.catch((error) =>
				unavailable(error.cause)
					? acquireHostUnderLock(dataDir, launch)
					: error,
			),
		);
	});

export const launchHost = async (
	dataDir: string,
	args: ReadonlyArray<string>,
) => {
	const log = await open(join(dataDir, 'service.log'), 'a');
	try {
		const entry = new URL(
			import.meta.url.endsWith('.ts')
				? '../../../dist/services/shared/entry.js'
				: './services/shared/entry.js',
			import.meta.url,
		);
		const child = spawn(
			process.execPath,
			[...process.execArgv, entry.pathname, ...args],
			{
				detached: true,
				stdio: ['ignore', log.fd, log.fd],
			},
		);
		await new Promise<void>((resolve, reject) => {
			child.once('spawn', resolve);
			child.once('error', reject);
		});
		child.unref();
		return child;
	} finally {
		await log.close();
	}
};
