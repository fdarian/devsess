import { Context, Effect, Layer } from 'effect';
import { FileSystem } from 'effect/FileSystem';
import { Path } from 'effect/Path';
import type { Scope } from 'effect/Scope';
import { CurrentSession } from '../current-session';
import { reportDaemonService } from '../dev/daemon-services';
import { getStickyPort } from '../dev/sticky-port';
import type { DevSession } from '../dev-sessions';
import { type ContainerSpec, startContainer } from './container';
import { type ServiceContext, ServiceError, validName } from './core';

export type { Healthcheck } from './docker-args';
export { type ServiceContext, ServiceError };

export type RunningService<Port extends string, A> = (A extends object
	? Omit<A, 'ports'>
	: unknown) & { readonly ports: Readonly<Record<Port, number>> };

type ServiceIdentifier<Name extends string> = {
	readonly devsessService: Name;
};

export type ServiceDefinition<
	Name extends string,
	Port extends string,
	A,
	E,
	R,
> = {
	readonly name: Name;
	readonly ports: ReadonlyArray<Port>;
	/** Resolves once the service is ready; its scope closing stops it. */
	readonly start: (ctx: ServiceContext<Port>) => Effect.Effect<A, E, R>;
	/** Yield inside another service's `start` (or any effect) to depend on this one. */
	readonly key: Context.Key<ServiceIdentifier<Name>, RunningService<Port, A>>;
	/** Starts the service once per layer build and shares it with every consumer. */
	readonly layer: Layer.Layer<
		ServiceIdentifier<Name>,
		E | ServiceError,
		Exclude<R, Scope> | CurrentSession | FileSystem | Path
	>;
};

const run = <Name extends string, Port extends string, A, E, R>(
	session: DevSession,
	def: Pick<ServiceDefinition<Name, Port, A, E, R>, 'name' | 'ports' | 'start'>,
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
	}).pipe(
		Effect.mapError((cause) =>
			cause instanceof ServiceError
				? cause
				: new ServiceError({
						message: `Failed to prepare service ${def.name}`,
						cause,
					}),
		),
		Effect.flatMap((prepared) =>
			def
				.start({ session, ports: prepared.ports, dataDir: prepared.dataDir })
				.pipe(
					Effect.tap(() => reportDaemonService(def.name, prepared.ports)),
					Effect.map(
						(value) =>
							({
								...(typeof value === 'object' && value !== null ? value : {}),
								ports: prepared.ports,
							}) as RunningService<Port, A>,
					),
				),
		),
		Effect.annotateLogs({ service: def.name }),
	);

const make = <
	const Name extends string,
	A,
	E,
	R,
	const Port extends string = never,
>(def: {
	name: Name;
	ports?: ReadonlyArray<Port>;
	start: (ctx: ServiceContext<Port>) => Effect.Effect<A, E, R>;
}): ServiceDefinition<Name, Port, A, E, R> => {
	const base = { name: def.name, ports: def.ports ?? [], start: def.start };
	const key = Context.Service<ServiceIdentifier<Name>, RunningService<Port, A>>(
		`devsess/services/${def.name}`,
	);
	const layer = Layer.effect(
		key,
		Effect.gen(function* () {
			const session = yield* CurrentSession;
			return yield* run(session, base);
		}),
	);
	return { ...base, key, layer };
};

export const Service = {
	/** Defines a service whose `start` handler you write yourself. */
	make,
	/** Defines a service backed by a Docker container, ready once its healthcheck passes. */
	container: <const Name extends string, const Port extends string = never>(
		def: { name: Name } & ContainerSpec<Port>,
	) =>
		make({
			name: def.name,
			ports: Object.keys(def.ports ?? {}) as Port[],
			start: startContainer(def.name, def),
		}),
	/** Starts a service in `session`, outside a layer. */
	run,
};
