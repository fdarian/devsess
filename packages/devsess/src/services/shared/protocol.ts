import { type ChildProcess, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, open, readlink, rm, symlink } from 'node:fs/promises';
import { connect, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Effect, Schedule } from 'effect';
import { acquireFileLock } from '../../lock';
import { readSocketLine } from '../../socket-line';
import { ServiceError } from '../core';

export const sharedGraceMs = 5_000;

export const io = <A>(operation: () => Promise<A>) =>
	Effect.tryPromise({
		try: () => operation(),
		catch: (cause) =>
			new ServiceError({ message: 'Shared service protocol failed', cause }),
	});

export const startupLock = (dataDir: string) =>
	acquireFileLock(dataDir, join(dataDir, 'startup.lock')).pipe(
		Effect.mapError(
			(cause) =>
				new ServiceError({
					message: 'Failed to acquire shared host lock',
					cause,
				}),
		),
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

class HostUnavailable extends Error {}

export const connectHost = async (
	dataDir: string,
	child?: ChildProcess,
): Promise<Lease> => {
	const socket = connect(await socketPath(dataDir));
	const exited = () =>
		socket.destroy(new Error('Host exited before readiness'));
	child?.once('exit', exited);
	try {
		if (
			child !== undefined &&
			(child.exitCode !== null || child.signalCode !== null)
		)
			exited();
		const line = await readSocketLine(socket);
		socket.on('error', () => socket.destroy());
		return { socket, line };
	} catch (cause) {
		socket.destroy();
		throw new HostUnavailable('Host did not send readiness', { cause });
	} finally {
		child?.removeListener('exit', exited);
	}
};

const unavailable = (cause: unknown) => cause instanceof HostUnavailable;

const logTail = async (dir: string) => {
	const file = await open(join(dir, 'service.log'), 'r');
	try {
		const size = (await file.stat()).size;
		const buffer = Buffer.alloc(Math.min(size, 8_192));
		const read = await file.read(
			buffer,
			0,
			buffer.length,
			Math.max(0, size - buffer.length),
		);
		return buffer.subarray(0, read.bytesRead).toString('utf8');
	} finally {
		await file.close();
	}
};

type Launch = () => Promise<void> | Promise<ChildProcess>;

const startHost = (dataDir: string, launch: Launch) =>
	Effect.gen(function* () {
		yield* io(() => rm(join(dataDir, 'host.sock'), { force: true }));
		const child = yield* io(() =>
			launch().then((child) => (child === undefined ? undefined : child)),
		);
		return yield* Effect.suspend(() => {
			if (
				child !== undefined &&
				(child.exitCode !== null || child.signalCode !== null)
			)
				return io(() => logTail(dataDir)).pipe(
					Effect.flatMap(
						(log) =>
							new ServiceError({
								message: `Shared host failed to start: ${log}`,
							}),
					),
				);
			return io(() => connectHost(dataDir, child));
		}).pipe(
			Effect.retry({
				while: (error) => unavailable(error.cause),
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
			[...process.execArgv, fileURLToPath(entry), ...args],
			{
				detached: true,
				env: Object.fromEntries(
					Object.entries(process.env).filter(
						(entry) => !entry[0].startsWith('DEVSESS_'),
					),
				),
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
