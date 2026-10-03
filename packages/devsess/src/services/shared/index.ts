import { Effect, Schema } from 'effect';
import { FileSystem } from 'effect/FileSystem';
import { reportDaemonService } from '../../dev/daemon-services';
import { resolveSiblingDir } from '../../dev/running-signal';
import { type DevSession, DevSessions } from '../../dev-sessions';
import { ServiceError, validName } from '../core';
import type { RunningService } from '../index';
import { acquireHost, io, launchHost, startupLock } from './protocol';

export type SharedOptions<A> = {
	readonly module: string;
	readonly output: Schema.Codec<A, unknown>;
	readonly home?: string;
};

const resolveHomeSession = (session: DevSession, home: string | undefined) =>
	Effect.gen(function* () {
		if (home === undefined) return session;
		const currentPath = yield* session.path('');
		const root = yield* Effect.try({
			try: () =>
				resolveSiblingDir(home, resolveSiblingDir('../../..', currentPath)),
			catch: (cause) =>
				new ServiceError({
					message: 'Failed to resolve shared service home',
					cause,
				}),
		});
		const fs = yield* FileSystem;
		yield* fs.makeDirectory(`${root}/.data/sessions`, { recursive: true });
		return yield* Effect.gen(function* () {
			yield* Effect.acquireRelease(startupLock(`${root}/.data`), (release) =>
				io(release).pipe(Effect.orDie),
			);
			const sessions = yield* DevSessions;
			return yield* sessions.getLatestOrCreate;
		}).pipe(Effect.scoped, Effect.provide(DevSessions.layerAt(root)));
	});

export const runShared = <Port extends string, A>(
	session: DevSession,
	name: string,
	options: SharedOptions<A>,
) =>
	Effect.gen(function* () {
		if (!validName(name) || !validName(session.name))
			return yield* new ServiceError({
				message: 'Invalid shared service or session name',
			});
		const home = yield* resolveHomeSession(session, options.home);
		const sessionDir = yield* home.path('');
		const dataDir = `${sessionDir}/services/${name}`;
		const lease = yield* Effect.acquireRelease(
			acquireHost(dataDir, () =>
				launchHost(dataDir, [options.module, name, sessionDir]),
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
