import { type ChildProcess, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, open, readlink, rm, symlink } from 'node:fs/promises';
import { connect, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Effect, Schedule, Schema } from 'effect';
import { acquireFileLock } from '../../lock';
import { readSocketLine } from '../../socket-line';
import { ServiceError, withServiceError } from '../core';

export const sharedGraceMs = 5_000;
export const hostPaths = (sessionDir: string, name: string) => {
	const dir = join(sessionDir, 'hosts', name);
	return {
		dir,
		socket: join(dir, 'host.sock'),
		lock: join(dir, 'startup.lock'),
		log: join(dir, 'service.log'),
	};
};
export type HostPaths = ReturnType<typeof hostPaths>;
export const hostArguments = Schema.fromJsonString(
	Schema.Struct({
		module: Schema.String,
		name: Schema.String,
		root: Schema.String,
		session: Schema.String,
	}),
);
type HostArguments = typeof hostArguments.Type;
export const readyMessage = <A>(output: Schema.Codec<A, unknown>) =>
	Schema.fromJsonString(
		Schema.Struct({
			output,
			ports: Schema.Record(Schema.String, Schema.Number),
		}),
	);

export const io = <A>(message: string, operation: () => Promise<A>) =>
	Effect.tryPromise({
		try: () => operation(),
		catch: (cause) => new ServiceError({ message, cause }),
	});
export const isErrno = (cause: unknown, code: string) =>
	typeof cause === 'object' &&
	cause !== null &&
	'code' in cause &&
	cause.code === code;
export const startupLock = (paths: HostPaths) =>
	acquireFileLock(paths.dir, paths.lock).pipe(
		withServiceError('Failed to acquire shared host lock'),
	);
export type Lease = { socket: Socket; line: string };

/** Unix sockets have tiny pathname limits; a short alias keeps the socket in the host directory. */
export const socketPath = async (paths: HostPaths) => {
	if (Buffer.byteLength(paths.socket) < 100) return paths.socket;
	const alias = join(
		tmpdir(),
		`dvs-${createHash('sha256').update(paths.dir).digest('hex').slice(0, 16)}`,
	);
	await symlink(paths.dir, alias).catch(async (cause: unknown) => {
		if (!isErrno(cause, 'EEXIST')) throw cause;
		if ((await readlink(alias)) !== paths.dir)
			throw new Error(`Unexpected shared socket alias: ${alias}`);
	});
	return join(alias, basename(paths.socket));
};
class HostUnavailable extends Error {}
export const connectHost = async (
	paths: HostPaths,
	child?: ChildProcess,
): Promise<Lease> => {
	const socket = connect(await socketPath(paths));
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
const logTail = async (paths: HostPaths) => {
	const file = await open(paths.log, 'r');
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
type Launch = () => Promise<ChildProcess>;
const startHost = (paths: HostPaths, launch: Launch) =>
	Effect.gen(function* () {
		yield* io('Failed to remove stale host socket', () =>
			rm(paths.socket, { force: true }),
		);
		const child = yield* io('Failed to launch shared host', launch);
		return yield* Effect.suspend(() => {
			if (child.exitCode !== null || child.signalCode !== null)
				return io('Failed to read shared host log', () => logTail(paths)).pipe(
					Effect.flatMap(
						(log) =>
							new ServiceError({
								message: `Shared host failed to start: ${log}`,
							}),
					),
				);
			return io('Failed to read shared host readiness', () =>
				connectHost(paths, child),
			);
		}).pipe(
			Effect.retry({
				while: (error) => unavailable(error.cause),
				schedule: Schedule.spaced('50 millis'),
			}),
		);
	});
const acquireHostUnderLock = (paths: HostPaths, launch: Launch) =>
	Effect.gen(function* () {
		yield* Effect.acquireRelease(startupLock(paths), (release) =>
			io('Failed to release shared host lock', release).pipe(Effect.orDie),
		);
		return yield* io('Failed to connect to shared host', () =>
			connectHost(paths),
		).pipe(
			Effect.catch((error) =>
				unavailable(error.cause) ? startHost(paths, launch) : error,
			),
		);
	}).pipe(Effect.scoped);
export const acquireHost = (paths: HostPaths, launch: Launch) =>
	Effect.gen(function* () {
		yield* io('Failed to create shared host directory', () =>
			mkdir(paths.dir, { recursive: true }),
		);
		return yield* io('Failed to connect to shared host', () =>
			connectHost(paths),
		).pipe(
			Effect.catch((error) =>
				unavailable(error.cause) ? acquireHostUnderLock(paths, launch) : error,
			),
		);
	});
export const launchHost = async (paths: HostPaths, args: HostArguments) => {
	const log = await open(paths.log, 'a');
	try {
		const entry = new URL(
			import.meta.url.endsWith('.ts')
				? '../../../dist/services/shared/entry.js'
				: './services/shared/entry.js',
			import.meta.url,
		);
		const child = spawn(
			process.execPath,
			[...process.execArgv, fileURLToPath(entry), JSON.stringify(args)],
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
