import { Data, Effect, Stream } from 'effect';
import { FileSystem } from 'effect/FileSystem';
import { Path } from 'effect/Path';
import { ChildProcess } from 'effect/unstable/process';
import { getStickyPort } from '../dev/sticky-port';
import { type DevSession, DevSessions } from '../dev-sessions';
import { buildRunArgs, type Healthcheck, selectOrphans } from './docker-args';

export class ServiceError extends Data.TaggedError('ServiceError')<{
	message: string;
	cause?: unknown;
}> {}

export type ServiceDefinition<
	Ports extends Record<string, number> = Record<string, number>,
> = {
	name: string;
	image: string;
	ports?: Ports;
	volumes?: Record<string, string>;
	env?: Record<string, string>;
	healthcheck?: Healthcheck;
};

type PortNames<D extends ServiceDefinition> = D extends { ports: infer P }
	? Extract<keyof P, string>
	: never;

const docker = (
	args: string[],
	options?: { progress?: boolean; allowFailure?: boolean },
) =>
	Effect.gen(function* () {
		const command = ChildProcess.make('docker', args, {
			stdout: options?.progress ? 'inherit' : 'pipe',
			stderr: 'inherit',
		});
		const result = yield* Effect.scoped(
			Effect.gen(function* () {
				const child = yield* command;
				const output = options?.progress
					? undefined
					: (yield* Stream.mkString(Stream.decodeText(child.stdout))).trim();
				const code = yield* child.exitCode;
				return { output, code };
			}),
		).pipe(
			Effect.mapError(
				(cause) =>
					new ServiceError({
						message: `Docker command failed: docker ${args.join(' ')}`,
						cause,
					}),
			),
		);
		if (result.code !== 0 && !options?.allowFailure) {
			return yield* new ServiceError({
				message: `Docker command failed (exit ${result.code}): docker ${args.join(' ')}`,
			});
		}
		return result;
	});

const validName = (name: string) => /^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/.test(name);

const listContainers = (root: string) =>
	Effect.gen(function* () {
		const listed = yield* docker([
			'ps',
			'-a',
			'--filter',
			`label=devsess.root=${root}`,
			'--format',
			'{{.ID}}\t{{.Label "devsess.session"}}',
		]);
		if (listed.output === undefined)
			return yield* new ServiceError({
				message: 'Docker container listing returned no output',
			});
		const containers: Array<{ id: string; session: string }> = [];
		for (const line of listed.output.split('\n').filter(Boolean)) {
			const fields = line.split('\t');
			const id = fields[0];
			const session = fields[1];
			if (!id || !session)
				return yield* new ServiceError({
					message: `Invalid devsess container metadata: ${line}`,
				});
			containers.push({ id, session });
		}
		return containers;
	});

const waitHealthy = (name: string, container: string) =>
	Effect.gen(function* () {
		while (true) {
			const state = yield* docker([
				'inspect',
				'--format',
				'{{.State.Running}} {{.State.Health.Status}}',
				container,
			]);
			if (state.output === undefined)
				return yield* new ServiceError({
					message: `Docker returned no status for ${container}`,
				});
			if (state.output === 'true healthy') return;
			if (state.output.startsWith('false '))
				return yield* new ServiceError({
					message: `Service ${name} exited before healthy; services run as your user; this image may require root`,
				});
			if (state.output === 'true unhealthy')
				return yield* new ServiceError({
					message: `Service ${name} is unhealthy`,
				});
			yield* Effect.sleep('500 millis');
		}
	});

export const Service = {
	make: <const D extends ServiceDefinition>(def: D): D => def,
	run: <D extends ServiceDefinition>(session: DevSession, def: D) =>
		Effect.gen(function* () {
			if (!validName(def.name) || !validName(session.name)) {
				return yield* new ServiceError({
					message:
						'Service and session names must contain only letters, numbers, dots, underscores, or hyphens',
				});
			}
			const fs = yield* FileSystem;
			const path = yield* Path;
			const sessions = yield* DevSessions;
			const sessionDir = yield* session.path('');

			const known = new Set(
				(yield* sessions.getSessions).map((existing) => existing.name),
			);
			const containers = yield* listContainers(sessions.dir);
			for (const id of selectOrphans(containers, known))
				yield* docker(['rm', '-f', id]);

			const container = `devsess-${session.name}-${def.name}`;
			const ports = {} as Record<PortNames<D>, number>;
			const portBindings: Array<{ host: number; container: number }> = [];
			for (const entry of Object.entries(def.ports ?? {})) {
				const host = yield* getStickyPort(session, {
					name: `${def.name}:${entry[0]}`,
				});
				ports[entry[0] as PortNames<D>] = host;
				portBindings.push({ host, container: entry[1] });
			}
			const volumes: Array<{ source: string; target: string }> = [];
			for (const entry of Object.entries(def.volumes ?? {})) {
				if (!validName(entry[0]))
					return yield* new ServiceError({
						message: `Invalid volume name: ${entry[0]}`,
					});
				volumes.push({
					source: path.join(sessionDir, 'services', def.name, entry[0]),
					target: entry[1],
				});
			}

			const start = Effect.gen(function* () {
				const found = yield* docker(
					[
						'container',
						'inspect',
						'--format',
						'{{.State.Running}}\t{{index .Config.Labels "devsess.root"}}\t{{index .Config.Labels "devsess.session"}}',
						container,
					],
					{ allowFailure: true },
				);
				const identity = found.output?.split('\t');
				if (
					found.code === 0 &&
					(identity?.[1] !== sessions.dir || identity[2] !== session.name)
				)
					return yield* new ServiceError({
						message: `Container name ${container} belongs to another session or project`,
					});
				if (found.code === 0 && identity?.[0] === 'true') return;
				if (found.code === 0) yield* docker(['rm', '-f', container]);
				if (!process.getuid || !process.getgid)
					return yield* new ServiceError({
						message: 'Docker services require a POSIX user and group ID',
					});
				for (const volume of volumes)
					yield* fs.makeDirectory(volume.source, { recursive: true });
				const image = yield* docker(
					['image', 'inspect', '--format', '{{.Id}}', def.image],
					{ allowFailure: true },
				);
				if (image.code !== 0) {
					yield* Effect.logInfo(`[dev] pulling ${def.image}`);
					yield* docker(['pull', def.image], { progress: true });
				}
				yield* docker(
					buildRunArgs({
						image: def.image,
						container,
						root: sessions.dir,
						session: session.name,
						uid: process.getuid(),
						gid: process.getgid(),
						ports: portBindings,
						volumes,
						env: def.env ?? {},
						healthcheck: def.healthcheck,
					}),
				);
			});
			yield* Effect.acquireRelease(start, () =>
				docker(['rm', '-f', container]).pipe(
					Effect.catch((error) =>
						Effect.logError(`[dev] failed to remove ${container}: ${error}`),
					),
				),
			);
			if (def.healthcheck) yield* waitHealthy(def.name, container);
			return { ports, container };
		}).pipe(
			Effect.mapError((cause) =>
				cause instanceof ServiceError
					? cause
					: new ServiceError({
							message: `Failed to start service ${def.name}`,
							cause,
						}),
			),
		),
};
