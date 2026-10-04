import { Effect } from 'effect';
import { FileSystem } from 'effect/FileSystem';
import { Path } from 'effect/Path';
import { reportDaemonService } from '../dev/daemon-services';
import { getStickyPort } from '../dev/sticky-port';
import type { DevSession } from '../dev-sessions';
import { ServiceError, validName, withServiceError } from './core';
import type { ServiceDefinition } from './index';

const prepareLocal = <Name extends string, Port extends string>(
	session: DevSession,
	def: { readonly name: Name; readonly ports: ReadonlyArray<Port> },
) =>
	Effect.gen(function* () {
		if (!validName(def.name) || !validName(session.name)) {
			return yield* new ServiceError({
				message:
					'Service and session names must contain only letters, numbers, dots, underscores, or hyphens',
			});
		}
		const fs = yield* FileSystem;
		const path = yield* Path;
		const dataDir = path.join(yield* session.path(''), 'services', def.name);
		const ports = {} as Record<Port, number>;
		for (const port of def.ports)
			ports[port] = yield* getStickyPort(session, {
				name: `${def.name}:${port}`,
			});
		yield* fs.makeDirectory(dataDir, { recursive: true });
		return { ports, dataDir };
	}).pipe(withServiceError(`Failed to prepare service ${def.name}`));

export const runLocal = <Name extends string, Port extends string, A, E, R>(
	session: DevSession,
	def: Pick<ServiceDefinition<Name, Port, A, E, R>, 'name' | 'ports' | 'start'>,
) =>
	Effect.gen(function* () {
		const prepared = yield* prepareLocal(session, def);
		const value = yield* def.start({
			session,
			ports: prepared.ports,
			dataDir: prepared.dataDir,
		});
		yield* reportDaemonService(def.name, prepared.ports);
		return { value, ports: prepared.ports };
	}).pipe(Effect.annotateLogs({ service: def.name }));
