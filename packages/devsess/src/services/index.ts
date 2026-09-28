import { Data, Duration, Effect, Stream } from 'effect';
import { FileSystem } from 'effect/FileSystem';
import { Path } from 'effect/Path';
import { ChildProcess } from 'effect/unstable/process';
import { getStickyPort } from '../dev/sticky-port';
import { type DevSession, DevSessions } from '../dev-sessions';

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
	healthcheck?: {
		test: readonly string[];
		interval?: Duration.Input;
		timeout?: Duration.Input;
		retries?: number;
		startPeriod?: Duration.Input;
	};
};

type PortNames<D extends ServiceDefinition> = D extends { ports: infer P }
	? Extract<keyof P, string>
	: never;

const dockerDuration = (input: Duration.Input) =>
	`${Duration.toMillis(input)}ms`;

export const buildRunArgs = <D extends ServiceDefinition>(
	def: D,
	resolved: {
		container: string;
		root: string;
		session: string;
		uid: number;
		gid: number;
		ports: Record<PortNames<D>, number>;
		volumes: Record<string, string>;
	},
): string[] => {
	const args = [
		'run',
		'-d',
		'--name',
		resolved.container,
		'--label',
		`devsess.session=${resolved.session}`,
		'--label',
		`devsess.root=${resolved.root}`,
		'--user',
		`${resolved.uid}:${resolved.gid}`,
	];
	for (const entry of Object.entries(def.ports ?? {})) {
		const hostPort = resolved.ports[entry[0] as PortNames<D>];
		args.push('-p', `127.0.0.1:${hostPort}:${entry[1]}`);
	}
	for (const entry of Object.entries(def.volumes ?? {})) {
		const source = resolved.volumes[entry[0]];
		if (source === undefined)
			throw new ServiceError({
				message: `Missing resolved volume ${entry[0]}`,
			});
		args.push('-v', `${source}:${entry[1]}`);
	}
	for (const entry of Object.entries(def.env ?? {}))
		args.push('-e', `${entry[0]}=${entry[1]}`);
	if (def.healthcheck) {
		const test = def.healthcheck.test;
		args.push(
			'--health-cmd',
			test[0] === 'CMD-SHELL'
				? test.slice(1).join(' ')
				: test[0] === 'CMD'
					? test
							.slice(1)
							.map((part) => `'${part.replaceAll("'", "'\\''")}'`)
							.join(' ')
					: test.join(' '),
		);
		if (def.healthcheck.interval !== undefined)
			args.push('--health-interval', dockerDuration(def.healthcheck.interval));
		if (def.healthcheck.timeout !== undefined)
			args.push('--health-timeout', dockerDuration(def.healthcheck.timeout));
		if (def.healthcheck.retries !== undefined)
			args.push('--health-retries', String(def.healthcheck.retries));
		if (def.healthcheck.startPeriod !== undefined)
			args.push(
				'--health-start-period',
				dockerDuration(def.healthcheck.startPeriod),
			);
	}
	args.push(def.image);
	return args;
};

export const selectOrphans = (
	containers: readonly { id: string; session: string }[],
	existingSessions: ReadonlySet<string>,
) =>
	containers
		.filter((container) => !existingSessions.has(container.session))
		.map((container) => container.id);

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
			const sessionRoot = path.join(sessions.dir, '.data', 'sessions');
			const listed = yield* docker([
				'ps',
				'-a',
				'--filter',
				`label=devsess.root=${sessions.dir}`,
				'--format',
				'{{.ID}}\t{{.Label "devsess.session"}}',
			]);
			if (listed.output === undefined)
				return yield* new ServiceError({
					message: 'Docker container listing returned no output',
				});
			const containers = listed.output
				.split('\n')
				.filter(Boolean)
				.map((line) => {
					const fields = line.split('\t');
					const id = fields[0];
					const sessionName = fields[1];
					if (!id || !sessionName || !validName(sessionName))
						throw new ServiceError({
							message: `Invalid devsess container metadata: ${line}`,
						});
					return { id, session: sessionName };
				});
			const existing = new Set<string>();
			for (const container of containers) {
				if (yield* fs.exists(path.join(sessionRoot, container.session)))
					existing.add(container.session);
			}
			for (const id of selectOrphans(containers, existing))
				yield* docker(['rm', '-f', id]);

			const container = `devsess-${session.name}-${def.name}`;
			const ports = {} as Record<PortNames<D>, number>;
			for (const name of Object.keys(def.ports ?? {}) as PortNames<D>[]) {
				ports[name] = yield* getStickyPort(session, {
					name: `${def.name}:${name}`,
				});
			}
			const volumes: Record<string, string> = {};
			for (const name of Object.keys(def.volumes ?? {})) {
				if (!validName(name))
					return yield* new ServiceError({
						message: `Invalid volume name: ${name}`,
					});
				volumes[name] = path.join(sessionDir, 'services', def.name, name);
			}

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
			const running = identity?.[0] === 'true';
			if (found.code === 0 && !running) yield* docker(['rm', '-f', container]);
			if (!running) {
				if (!process.getuid || !process.getgid)
					return yield* new ServiceError({
						message: 'Docker services require a POSIX user and group ID',
					});
				for (const source of Object.values(volumes))
					yield* fs.makeDirectory(source, { recursive: true });
				const image = yield* docker(
					['image', 'inspect', '--format', '{{.Id}}', def.image],
					{
						allowFailure: true,
					},
				);
				if (image.code !== 0) {
					yield* Effect.logInfo(`[dev] pulling ${def.image}`);
					yield* docker(['pull', def.image], { progress: true });
				}
				yield* docker(
					buildRunArgs(def, {
						container,
						root: sessions.dir,
						session: session.name,
						uid: process.getuid(),
						gid: process.getgid(),
						ports,
						volumes,
					}),
				);
			}
			yield* Effect.acquireRelease(Effect.succeed(container), (name) =>
				docker(['rm', '-f', name]).pipe(
					Effect.catch((error) =>
						Effect.logError(`[dev] failed to remove ${name}: ${error}`),
					),
				),
			);
			if (def.healthcheck) {
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
					if (state.output === 'true healthy') break;
					if (state.output.startsWith('false '))
						return yield* new ServiceError({
							message: `Service ${def.name} exited before healthy; services run as your user; this image may require root`,
						});
					if (state.output === 'true unhealthy')
						return yield* new ServiceError({
							message: `Service ${def.name} is unhealthy`,
						});
					yield* Effect.sleep('500 millis');
				}
			}
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
