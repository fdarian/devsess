import { createServer, type Server, type Socket } from 'node:net';
import { Context, Deferred, Effect, Layer, Queue, Schema } from 'effect';
import type { FileSystem } from 'effect/FileSystem';
import type { Path } from 'effect/Path';
import type { IPty } from 'node-pty';
import { type LogAddress, Logs } from './logs';
import { Processes, type ProcessIdentity } from './processes';
import {
	type DaemonEvent,
	type DaemonRequest,
	type DaemonResponse,
	decodeRequest,
	PROTOCOL_VERSION,
	splitFrames,
} from './protocol';
import { createPty, resizePty, writePty } from './pty';
import {
	Registry,
	type RunRecord,
	type ServiceRecord,
	type ServiceState,
} from './registry';

export class DaemonError extends Schema.TaggedErrorClass<DaemonError>()(
	'DaemonError',
	{
		message: Schema.String,
		cause: Schema.optional(Schema.Defect()),
	},
) {}

export class Daemon extends Context.Service<
	Daemon,
	{
		readonly request: (
			incoming: DaemonRequest,
		) => Effect.Effect<unknown, DaemonError>;
	}
>()('devsess/cli/Daemon') {
	static readonly layer = (options: {
		socketPath: string;
		dataDirectory: string;
		maxLogBytes: number;
	}) =>
		Layer.effect(Daemon, makeDaemon(options)).pipe(
			Layer.provide(Registry.layer({ dataDirectory: options.dataDirectory })),
			Layer.provide(
				Logs.layer({
					dataDirectory: options.dataDirectory,
					maxBytes: options.maxLogBytes,
				}),
			),
			Layer.provide(Processes.layer),
		);
}

type LiveService = {
	readonly terminal: IPty;
	readonly process: ProcessIdentity;
	lease:
		| { readonly id: string; readonly socket: Socket | undefined }
		| undefined;
};
type SocketState = { readonly subscriptions: Map<string, Effect.Effect<void>> };
type Message =
	| {
			readonly _tag: 'request';
			readonly incoming: DaemonRequest | string;
			readonly socket: Socket | undefined;
			readonly reply: Deferred.Deferred<unknown, DaemonError> | undefined;
	  }
	| { readonly _tag: 'connected'; readonly socket: Socket }
	| { readonly _tag: 'closed'; readonly socket: Socket }
	| {
			readonly _tag: 'ptyOutput';
			readonly address: LogAddress;
			readonly data: string;
	  }
	| {
			readonly _tag: 'delivery';
			readonly socket: Socket;
			readonly requestId: string;
			readonly event: { readonly data: string; readonly offset: number };
	  }
	| {
			readonly _tag: 'exited';
			readonly address: LogAddress;
			readonly exitCode: number;
	  };

const serviceKey = (address: LogAddress) =>
	`${address.runId}:${address.serviceName}`;
const parseShellCommand = (command: string) =>
	['/bin/sh', ['-c', command]] as const;
const active = (state: ServiceState) =>
	state === 'starting' || state === 'running' || state === 'stopping';
const aggregateState = (
	services: ReadonlyArray<ServiceRecord>,
): ServiceState => {
	if (services.some((service) => service.state === 'starting'))
		return 'starting';
	if (services.some((service) => service.state === 'stopping'))
		return 'stopping';
	if (services.some((service) => service.state === 'failed')) return 'failed';
	if (services.some((service) => service.state === 'orphaned'))
		return 'orphaned';
	if (services.every((service) => service.state === 'exited')) return 'exited';
	return 'running';
};
const errorMessage = (cause: unknown) =>
	cause instanceof Error ? cause.message : String(cause);

const listen = (server: Server, socketPath: string) =>
	Effect.tryPromise({
		try: () =>
			new Promise<void>((resolve, reject) => {
				server.once('error', reject);
				server.listen(socketPath, () => {
					server.off('error', reject);
					resolve();
				});
			}),
		catch: (cause) =>
			new DaemonError({ message: `Could not listen at ${socketPath}`, cause }),
	});
const closeServer = (server: Server) =>
	Effect.tryPromise({
		try: () =>
			new Promise<void>((resolve, reject) =>
				server.close((error) =>
					error === undefined ? resolve() : reject(error),
				),
			),
		catch: (cause) =>
			new DaemonError({ message: 'Could not close daemon socket', cause }),
	});

const makeDaemon = (options: { socketPath: string }) =>
	Effect.scoped(
		Effect.gen(function* () {
			const registry = yield* Registry;
			const logs = yield* Logs;
			const processes = yield* Processes;
			const daemonIdentity = yield* processes.capture(process.pid);
			const queue = yield* Queue.unbounded<Message>();
			const terminals = new Map<string, LiveService>();
			const sockets = new Map<Socket, SocketState>();
			const send = (socket: Socket, frame: DaemonResponse | DaemonEvent) =>
				Effect.sync(() => {
					if (!socket.destroyed) socket.write(`${JSON.stringify(frame)}\n`);
				});
			const reply = (socket: Socket, requestId: string, result: unknown) =>
				send(socket, {
					version: PROTOCOL_VERSION,
					requestId,
					ok: true,
					result,
				});
			const fail = (socket: Socket, requestId: string, cause: unknown) =>
				send(socket, {
					version: PROTOCOL_VERSION,
					requestId,
					ok: false,
					error: errorMessage(cause),
				});
			const replaceService = (address: LogAddress, state: ServiceState) =>
				registry.get(address.runId).pipe(
					Effect.flatMap((run) => {
						const services = run.services.map((service) =>
							service.name === address.serviceName
								? { ...service, state }
								: service,
						);
						return registry.replace({
							...run,
							services,
							state: aggregateState(services),
						});
					}),
				);
			const releaseSocket = (socket: Socket) =>
				Effect.gen(function* () {
					const state = sockets.get(socket);
					if (state !== undefined) {
						for (const unsubscribe of state.subscriptions.values())
							yield* unsubscribe;
						sockets.delete(socket);
					}
					for (const live of terminals.values())
						if (live.lease?.socket === socket) live.lease = undefined;
				});
			const subscribe = (
				socket: Socket,
				requestId: string,
				address: LogAddress,
				after: number,
			) =>
				Effect.gen(function* () {
					const state = sockets.get(socket);
					if (state === undefined) return;
					const subscription = yield* logs.replayAndSubscribe(
						address,
						after,
						(event) =>
							Effect.sync(() => {
								Queue.offerUnsafe(queue, {
									_tag: 'delivery',
									socket,
									requestId,
									event,
								});
							}),
					);
					for (const event of subscription.replay)
						yield* send(socket, {
							version: PROTOCOL_VERSION,
							requestId,
							event: 'output',
							data: event.data,
							offset: event.offset,
						});
					state.subscriptions.set(requestId, subscription.unsubscribe);
				});
			const reconcile = registry.list.pipe(
				Effect.flatMap((runs) =>
					Effect.forEach(runs, (run) => {
						if (!active(run.state)) return Effect.void;
						return Effect.forEach(run.services, (service) => {
							if (!active(service.state) || service.process === undefined) {
								return Effect.succeed(service);
							}
							return processes.owns(service.process).pipe(
								Effect.map((isOwned) => ({
									...service,
									state: isOwned ? ('orphaned' as const) : ('exited' as const),
								})),
							);
						}).pipe(
							Effect.flatMap((services) =>
								registry.replace({
									...run,
									services,
									state: aggregateState(services),
								}),
							),
						);
					}),
				),
			);
			yield* reconcile;
			const startRun = (
				request: Extract<DaemonRequest, { readonly method: 'startRun' }>,
			) =>
				Effect.gen(function* () {
					const existing = yield* registry.list;
					const matchingOrphan = existing.find(
						(candidate) =>
							candidate.projectName === request.params.projectName &&
							candidate.presetName === request.params.presetName &&
							candidate.state === 'orphaned',
					);
					if (matchingOrphan !== undefined) {
						const liveService = yield* Effect.findFirst(
							matchingOrphan.services,
							(service) =>
								service.process === undefined
									? Effect.succeed(false)
									: processes.owns(service.process),
						);
						if (liveService !== undefined) {
							return yield* new DaemonError({
								message: `Run ${matchingOrphan.runId} is orphaned and still owns a service process`,
							});
						}
					}
					const run: RunRecord = {
						runId: request.params.runId,
						projectName: request.params.projectName,
						presetName: request.params.presetName,
						canonicalCwd: request.params.canonicalCwd,
						invocationCwd: request.params.invocationCwd,
						configSnapshot: request.params.configSnapshot,
						startedAt: new Date().toISOString(),
						state: 'starting',
						daemon: daemonIdentity,
						services: request.params.services.map((service) => ({
							name: service.name,
							command: service.command,
							cwd: service.cwd,
							state: 'starting',
						})),
					};
					yield* registry.reserve(run);
					const rollback = registry.get(run.runId).pipe(
						Effect.flatMap((stored) =>
							Effect.forEach(stored.services, (service) =>
								service.process === undefined
									? Effect.void
									: processes
											.terminate(service.process)
											.pipe(Effect.catch(() => Effect.void)),
							),
						),
						Effect.andThen(registry.get(run.runId)),
						Effect.flatMap((stored) => {
							const services = stored.services.map((service) =>
								active(service.state)
									? { ...service, state: 'failed' as const }
									: service,
							);
							return registry.replace({
								...stored,
								services,
								state: aggregateState(services),
							});
						}),
					);
					return yield* Effect.gen(function* () {
						for (const service of run.services) {
							const shell = parseShellCommand(service.command);
							const terminal = yield* createPty({
								command: shell[0],
								args: [...shell[1]],
								cwd: service.cwd,
								env: request.params.environment,
								cols: 80,
								rows: 24,
							});
							const process = yield* processes.capture(terminal.pid);
							const address = { runId: run.runId, serviceName: service.name };
							terminals.set(serviceKey(address), {
								terminal,
								process,
								lease: undefined,
							});
							terminal.onData((data) => {
								Queue.offerUnsafe(queue, { _tag: 'ptyOutput', address, data });
							});
							terminal.onExit((event) => {
								Queue.offerUnsafe(queue, {
									_tag: 'exited',
									address,
									exitCode: event.exitCode,
								});
							});
							const stored = yield* registry.get(run.runId);
							const services = stored.services.map((candidate) =>
								candidate.name === service.name
									? { ...candidate, process, state: 'running' as const }
									: candidate,
							);
							yield* registry.replace({
								...stored,
								services,
								state: aggregateState(services),
							});
						}
						return yield* registry.get(run.runId);
					}).pipe(
						Effect.catch((cause) =>
							rollback.pipe(Effect.andThen(Effect.fail(cause))),
						),
					);
				});
			const stopRun = (runId: string) =>
				registry.get(runId).pipe(
					Effect.flatMap((run) =>
						Effect.gen(function* () {
							const stopping = run.services.map((service) =>
								active(service.state)
									? { ...service, state: 'stopping' as const }
									: service,
							);
							yield* registry.replace({
								...run,
								services: stopping,
								state: aggregateState(stopping),
							});
							yield* Effect.forEach(stopping, (service) =>
								service.process === undefined
									? Effect.void
									: processes
											.terminate(service.process)
											.pipe(Effect.catch(() => Effect.void)),
							);
							const stored = yield* registry.get(runId);
							const services = stored.services.map((service) =>
								service.state === 'stopping'
									? { ...service, state: 'exited' as const }
									: service,
							);
							return yield* registry.replace({
								...stored,
								services,
								state: aggregateState(services),
							});
						}),
					),
				);
			const processRequest = (
				incoming: DaemonRequest,
				socket: Socket | undefined,
			): Effect.Effect<unknown, unknown, FileSystem | Path> => {
				if (incoming.method === 'listRuns') return registry.list;
				if (incoming.method === 'startRun') return startRun(incoming);
				if (incoming.method === 'stopRun')
					return stopRun(incoming.params.runId);
				const address = {
					runId: incoming.params.runId,
					serviceName: incoming.params.serviceName,
				};
				if (incoming.method === 'tail')
					return socket === undefined
						? registry.get(address.runId)
						: subscribe(
								socket,
								incoming.requestId,
								address,
								incoming.params.after ?? 0,
							).pipe(Effect.as({}));
				const live = terminals.get(serviceKey(address));
				if (incoming.method === 'attach') {
					if (live === undefined)
						return Effect.fail(
							new DaemonError({ message: 'Service is not live' }),
						);
					if (live.lease !== undefined)
						return Effect.fail(
							new DaemonError({
								message: 'Service already has an input writer',
							}),
						);
					const leaseId = crypto.randomUUID();
					live.lease = { id: leaseId, socket };
					return socket === undefined
						? Effect.succeed({ leaseId })
						: subscribe(socket, incoming.requestId, address, 0).pipe(
								Effect.as({ leaseId }),
							);
				}
				if (live === undefined || live.lease?.id !== incoming.params.leaseId)
					return Effect.fail(
						new DaemonError({ message: 'Input writer lease is not held' }),
					);
				if (incoming.method === 'detach')
					return Effect.sync(() => {
						live.lease = undefined;
					}).pipe(Effect.as({}));
				if (incoming.method === 'input')
					return writePty(live.terminal, incoming.params.data).pipe(
						Effect.as({}),
					);
				return resizePty(
					live.terminal,
					incoming.params.cols,
					incoming.params.rows,
				).pipe(Effect.as({}));
			};
			const handle = (message: Message) => {
				if (message._tag === 'connected')
					return Effect.sync(() => {
						sockets.set(message.socket, { subscriptions: new Map() });
					});
				if (message._tag === 'closed') return releaseSocket(message.socket);
				if (message._tag === 'ptyOutput')
					return logs.append(message.address, message.data).pipe(
						Effect.asVoid,
						Effect.catch(() =>
							replaceService(message.address, 'failed').pipe(Effect.asVoid),
						),
					);
				if (message._tag === 'delivery')
					return send(message.socket, {
						version: PROTOCOL_VERSION,
						requestId: message.requestId,
						event: 'output',
						data: message.event.data,
						offset: message.event.offset,
					});
				if (message._tag === 'exited') {
					terminals.delete(serviceKey(message.address));
					return replaceService(
						message.address,
						message.exitCode === 0 ? 'exited' : 'failed',
					).pipe(
						Effect.asVoid,
						Effect.catch(() => Effect.void),
					);
				}
				const decoded =
					typeof message.incoming === 'string'
						? decodeRequest(message.incoming)
						: Effect.succeed(message.incoming);
				return decoded.pipe(
					Effect.flatMap((incoming) =>
						Effect.suspend(() => processRequest(incoming, message.socket)).pipe(
							Effect.tap((result) =>
								message.socket === undefined
									? Effect.void
									: reply(message.socket, incoming.requestId, result),
							),
							Effect.tap((result) =>
								message.reply === undefined
									? Effect.void
									: Deferred.succeed(message.reply, result),
							),
							Effect.catch((cause) =>
								Effect.all([
									message.socket === undefined
										? Effect.void
										: fail(message.socket, incoming.requestId, cause),
									message.reply === undefined
										? Effect.void
										: Deferred.fail(
												message.reply,
												new DaemonError({
													message: errorMessage(cause),
													cause,
												}),
											),
								]).pipe(Effect.asVoid),
							),
						),
					),
					Effect.catch((cause) =>
						message.socket === undefined
							? Effect.void
							: fail(message.socket, 'invalid', cause),
					),
				);
			};
			yield* Effect.forever(
				Queue.take(queue).pipe(Effect.flatMap(handle)),
			).pipe(Effect.forkScoped);
			const server = createServer((socket) => {
				Queue.offerUnsafe(queue, { _tag: 'connected', socket });
				let remainder = '';
				socket.on('data', (chunk) => {
					const frames = splitFrames(remainder, chunk.toString());
					if (frames._tag === 'TooLarge') {
						socket.destroy();
						return;
					}
					remainder = frames.remainder;
					for (const frame of frames.frames)
						Queue.offerUnsafe(queue, {
							_tag: 'request',
							incoming: frame,
							socket,
							reply: undefined,
						});
				});
				socket.once('close', () => {
					Queue.offerUnsafe(queue, { _tag: 'closed', socket });
				});
				socket.once('error', () => {
					Queue.offerUnsafe(queue, { _tag: 'closed', socket });
				});
			});
			yield* listen(server, options.socketPath);
			yield* Effect.addFinalizer(() =>
				Effect.all([
					Queue.shutdown(queue),
					Effect.forEach(terminals.values(), (live) =>
						processes
							.terminate(live.process)
							.pipe(Effect.catch(() => Effect.void)),
					),
					closeServer(server).pipe(Effect.catch(() => Effect.void)),
				]).pipe(Effect.asVoid),
			);
			return Daemon.of({
				request: (incoming: DaemonRequest) =>
					Effect.gen(function* () {
						const response = yield* Deferred.make<unknown, DaemonError>();
						yield* Queue.offer(queue, {
							_tag: 'request',
							incoming,
							socket: undefined,
							reply: response,
						});
						return yield* Deferred.await(response);
					}),
			});
		}),
	);
