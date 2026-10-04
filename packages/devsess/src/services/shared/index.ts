import { Effect, Option, Schema } from 'effect';
import { reportDaemonService } from '../../dev/daemon-services';
import { type DevSession, DevSessions } from '../../dev-sessions';
import { ServiceError, validName, withServiceError } from '../core';
import { definitionModule } from './callsite';
import { acquireHost, hostPaths, launchHost, readyMessage } from './protocol';
import { findSharedRoot } from './root';

export type SharedOptions<A> = { readonly output: Schema.Codec<A, unknown> };
const locateHost = (
	session: DevSession,
	name: string,
	stack: string | undefined,
) =>
	Effect.gen(function* () {
		const module = yield* definitionModule(stack);
		const sessions = Option.getOrUndefined(
			yield* Effect.serviceOption(DevSessions),
		);
		const projectDir =
			session.rootDir === undefined ? sessions?.dir : session.rootDir;
		if (projectDir === undefined)
			return yield* new ServiceError({
				message:
					'Shared services require a session project root or DevSessions',
			});
		const root = yield* findSharedRoot(projectDir);
		const sharedSession = yield* DevSessions.use((store) =>
			store.getOrCreate('shared-services'),
		).pipe(Effect.provide(DevSessions.layerAt(root)));
		const paths = hostPaths(yield* sharedSession.path(''), name);
		return { paths, args: { module, name, root, session: sharedSession.name } };
	});

export const runShared = <Port extends string, A>(
	session: DevSession,
	name: string,
	options: SharedOptions<A>,
	stack: string | undefined,
) =>
	Effect.gen(function* () {
		if (!validName(name) || !validName(session.name))
			return yield* new ServiceError({
				message: 'Invalid shared service or session name',
			});
		const host = yield* locateHost(session, name, stack);
		const lease = yield* Effect.acquireRelease(
			acquireHost(host.paths, () => launchHost(host.paths, host.args)),
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
		const ready = yield* Schema.decodeUnknownEffect(
			readyMessage(options.output),
		)(lease.line).pipe(withServiceError(`Invalid shared output from ${name}`));
		yield* reportDaemonService(name, ready.ports);
		return {
			value: ready.output,
			ports: ready.ports as Readonly<Record<Port, number>>,
		};
	}).pipe(withServiceError(`Failed to run shared service ${name}`));
