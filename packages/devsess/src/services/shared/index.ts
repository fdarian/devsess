import { Effect, Schema } from 'effect';
import { FileSystem } from 'effect/FileSystem';
import { Path } from 'effect/Path';
import { reportDaemonService } from '../../dev/daemon-services';
import type { DevSession } from '../../dev-sessions';
import { ServiceError, validName } from '../core';
import type { RunningService } from '../index';
import { acquireHost, io, launchHost, startupLock } from './protocol';
import { findSharedRoot } from './root';

export type SharedOptions<A> = {
	readonly output: Schema.Codec<A, unknown>;
};

const resolveSharedSession = (session: DevSession) =>
	Effect.gen(function* () {
		const path = yield* Path;
		const root = yield* findSharedRoot(
			path.resolve(yield* session.path(''), '../../..'),
		);
		const fs = yield* FileSystem;
		yield* fs.makeDirectory(`${root}/.data/sessions`, { recursive: true });
		return yield* Effect.gen(function* () {
			yield* Effect.acquireRelease(startupLock(`${root}/.data`), (release) =>
				io(release).pipe(Effect.orDie),
			);
			const sessionDir = path.join(root, '.data/sessions/shared-services');
			yield* fs.makeDirectory(sessionDir, { recursive: true });
			return sessionDir;
		}).pipe(Effect.scoped);
	});

export const runShared = <Port extends string, A>(
	session: DevSession,
	name: string,
	options: SharedOptions<A>,
	module: string | undefined,
) =>
	Effect.gen(function* () {
		if (!validName(name) || !validName(session.name))
			return yield* new ServiceError({
				message: 'Invalid shared service or session name',
			});
		if (module === undefined)
			return yield* new ServiceError({
				message: `Unable to locate the file that calls Service.make for shared service ${name}`,
			});
		const sessionDir = yield* resolveSharedSession(session);
		const dataDir = `${sessionDir}/services/${name}`;
		const lease = yield* Effect.acquireRelease(
			acquireHost(dataDir, () =>
				launchHost(dataDir, [module, name, sessionDir]),
			),
			(value) => Effect.sync(() => value.socket.destroy()),
		);
		yield* Effect.forkScoped(
			Effect.callback<never, ServiceError>((resume) => {
				const closed = () =>
					resume(
						new ServiceError({
							message: `Shared host ${name} exited while this consumer was active`,
						}),
					);
				lease.socket.once('close', closed);
				return Effect.sync(() => lease.socket.removeListener('close', closed));
			}).pipe(Effect.catch((error) => Effect.logError(error))),
		);
		return yield* Schema.decodeUnknownEffect(
			Schema.fromJsonString(
				Schema.Struct({
					output: options.output,
					ports: Schema.Record(Schema.String, Schema.Number),
				}),
			),
		)(lease.line).pipe(
			Effect.tap((value) => reportDaemonService(name, value.ports)),
			Effect.map(
				(value) =>
					({
						...(typeof value.output === 'object' && value.output !== null
							? value.output
							: {}),
						ports: value.ports,
					}) as RunningService<Port, A>,
			),
			Effect.mapError(
				(cause) =>
					new ServiceError({
						message: `Invalid shared output from ${name}`,
						cause,
					}),
			),
		);
	}).pipe(
		Effect.mapError((cause) =>
			cause instanceof ServiceError
				? cause
				: new ServiceError({
						message: `Failed to run shared service ${name}`,
						cause,
					}),
		),
	);
