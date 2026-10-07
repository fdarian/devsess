import { unlinkSync } from 'node:fs';
import { createServer, type Server, type Socket } from 'node:net';
import { join } from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import { Context, Deferred, Effect, Fiber, Layer, Option, Queue } from 'effect';
import type { FileSystem } from 'effect/FileSystem';
import type { Path } from 'effect/Path';
import type { Scope } from 'effect/Scope';
import devsessPackageJson from '../../package.json' with { type: 'json' };
import { DaemonError, errorMessage } from './daemon-errors';
import { Logs } from './logs';
import { makeOutputWorker } from './output-worker';
import { Processes, type ProcessesService } from './processes';
import {
	type DaemonEvent,
	type DaemonInfo,
	type DaemonRequest,
	type DaemonResponse,
	decodeRequestId,
	PROTOCOL_VERSION,
	splitFrames,
} from './protocol';
import { bestEffortPrune, Registry } from './registry';
import {
	type ClientRequestMessage,
	type LifecycleMessage,
	makeRequestDispatcher,
} from './request-dispatch';
import { makeRunStart } from './run-start';
import { makeRunStop } from './run-stop';
import { type LiveService, makeServiceState } from './service-state';
import { makeSocketWriter } from './socket-writer';
import { makeSubscriptions, type SocketState } from './subscriptions';

export { DaemonError } from './daemon-errors';

export type DaemonService = {
	readonly request: (
		incoming: DaemonRequest,
	) => Effect.Effect<unknown, DaemonError>;
	readonly awaitShutdown: Effect.Effect<void>;
};

export class Daemon extends Context.Service<Daemon, DaemonService>()(
	'devsess/cli/Daemon',
) {
	static readonly layer: (options: {
		socketPath: string;
		dataDirectory: string;
		logsDirectory: string;
		maxLogBytes: number;
	}) => Layer.Layer<Daemon, unknown, FileSystem | Path> = (options) =>
		Layer.effect(Daemon, makeDaemon(options)).pipe(
			Layer.provide(
				Registry.layer({
					dataDirectory: options.dataDirectory,
					logsDirectory: options.logsDirectory,
				}),
			),
			Layer.provide(
				Logs.layer({
					dataDirectory: options.dataDirectory,
					logsDirectory: options.logsDirectory,
					maxBytes: options.maxLogBytes,
				}),
			),
			Layer.provide(Processes.layer),
		);
}

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

/** Bound on stopping runs during shutdown; whatever survives it gets SIGKILL so the daemon always exits. */
export const SHUTDOWN_RUN_STOP_TIMEOUT_MS = 10_000;
const SHUTDOWN_REPLY_FLUSH_TIMEOUT_MS = 1_000;
const SHUTTING_DOWN_MESSAGE = 'Daemon is shutting down';

/** Stops accepting connections right away without waiting for open ones to end. */
const stopListening = (server: Server, socketPath: string) =>
	Effect.try({
		try: () => {
			if (server.listening) server.close();
			try {
				unlinkSync(socketPath);
			} catch (cause) {
				if (
					!(
						cause instanceof Error &&
						'code' in cause &&
						cause.code === 'ENOENT'
					)
				)
					throw cause;
			}
		},
		catch: (cause) =>
			new DaemonError({ message: 'Could not close daemon socket', cause }),
	});

const killProcessGroup = (processes: ProcessesService, live: LiveService) =>
	processes.owns(live.ownership.identity).pipe(
		Effect.flatMap((owned) =>
			owned
				? Effect.try({
						try: () =>
							process.kill(-live.ownership.identity.processGroupId, 'SIGKILL'),
						catch: (cause) => cause,
					})
				: Effect.logWarning(
						`Not killing process group ${live.ownership.identity.processGroupId}: its leader is gone or changed`,
					),
		),
		Effect.catch((cause) =>
			cause instanceof Error && 'code' in cause && cause.code === 'ESRCH'
				? Effect.void
				: Effect.logError(cause),
		),
	);

const requestIdOf = (incoming: ClientRequestMessage['incoming']) =>
	typeof incoming === 'string'
		? decodeRequestId(incoming).pipe(
				Effect.map((request) => request.requestId),
				Effect.catch(() => Effect.succeed('invalid')),
			)
		: Effect.succeed(incoming.requestId);

export const makeDaemon = (options: {
	socketPath: string;
	dataDirectory?: string;
	logsDirectory?: string;
	shutdownTimeoutMs?: number;
}): Effect.Effect<
	DaemonService,
	unknown,
	Registry | Logs | Processes | FileSystem | Path | Scope
> =>
	Effect.gen(function* () {
		const scriptPath = process.argv[1];
		if (scriptPath === undefined)
			return yield* new DaemonError({
				message: 'Could not determine the daemon script path',
			});
		const registry = yield* Registry;
		const logs = yield* Logs;
		const processes = yield* Processes;
		const daemonIdentity = yield* processes.capture(process.pid);
		const startedAt = new Date().toISOString();
		const shutdownRequested = yield* Deferred.make<void>();
		const requestQueue = yield* Queue.bounded<ClientRequestMessage>(256);
		const lifecycleQueue = yield* Queue.unbounded<LifecycleMessage>();
		const terminals = new Map<string, LiveService>();
		const environments = new Map<string, Readonly<Record<string, string>>>();
		const sockets = new Map<Socket, SocketState>();
		const lifecycle = { closing: false };
		const inFlight: { current: ClientRequestMessage | undefined } = {
			current: undefined,
		};
		const attachedClientCount = () =>
			new Set(
				Array.from(terminals.values()).flatMap((live) =>
					live.lease?.socket === undefined ? [] : [live.lease.socket],
				),
			).size;
		const info = () => {
			const dataDirectory = options.dataDirectory;
			if (dataDirectory === undefined)
				return Effect.fail(
					new DaemonError({ message: 'Daemon data directory is unavailable' }),
				);
			return registry.list.pipe(
				Effect.map(
					(runs): DaemonInfo => ({
						pid: process.pid,
						startedAt,
						executable: process.execPath,
						scriptPath,
						packageVersion: devsessPackageJson.version,
						protocolVersion: PROTOCOL_VERSION,
						socketPath: options.socketPath,
						dataDirectory,
						logsDirectory:
							options.logsDirectory === undefined
								? join(dataDirectory, 'logs')
								: options.logsDirectory,
						runCount: runs.length,
						liveServiceCount: terminals.size,
						attachedClientCount: attachedClientCount(),
					}),
				),
			);
		};
		const requestShutdown = Deferred.succeed(shutdownRequested, undefined).pipe(
			Effect.asVoid,
		);
		const enqueueLifecycle = (message: LifecycleMessage) => {
			Queue.offerUnsafe(lifecycleQueue, message);
		};
		const enqueueRequest = (message: ClientRequestMessage) => {
			if (Queue.offerUnsafe(requestQueue, message)) return;
			if (message.socket === undefined) {
				if (message.reply !== undefined)
					Effect.runFork(
						Deferred.fail(
							message.reply,
							new DaemonError({ message: 'Daemon request queue is closed' }),
						),
					);
				return;
			}
			const socket = message.socket;
			socket.pause();
			Effect.runFork(
				Queue.offer(requestQueue, message).pipe(
					Effect.ensuring(
						Effect.sync(() => {
							if (!socket.destroyed) socket.resume();
						}),
					),
					Effect.catch(() => Effect.void),
				),
			);
		};
		const send = (socket: Socket, frame: DaemonResponse | DaemonEvent) =>
			Effect.suspend(() => {
				const state = sockets.get(socket);
				return state === undefined || state.closed
					? Effect.void
					: state.writer.send(frame);
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
		const serviceState = makeServiceState({ registry, processes });
		const output = yield* makeOutputWorker({
			logs,
			onPersistenceFailure: (address, cause) =>
				enqueueLifecycle({
					_tag: 'persistenceFailure',
					address,
					cause,
				}),
		});
		const subscriptions = makeSubscriptions({
			logs,
			sockets,
			onRelease: (socket) => {
				for (const live of terminals.values())
					if (live.lease?.socket === socket) live.lease = undefined;
			},
			send,
		});
		const runStop = makeRunStop({
			registry,
			processes,
			terminals,
			output,
			subscriptions,
		});
		const runStart = makeRunStart({
			socketPath: options.socketPath,
			registry,
			processes,
			daemonIdentity,
			terminals,
			environments,
			output,
			serviceState,
			stopRun: runStop.stopRun,
			onExited: (address, exit, pid) =>
				enqueueLifecycle({
					_tag: 'exited',
					address,
					exitCode: exit.exitCode,
					signal: exit.signal,
					pid,
				}),
		});
		const dispatcher = makeRequestDispatcher({
			registry,
			terminals,
			environments,
			sockets,
			output,
			serviceState,
			subscriptions,
			runStart,
			runStop,
			info,
			requestShutdown,
			reply,
			fail,
		});
		yield* serviceState.reconcile;
		yield* bestEffortPrune(registry);
		const requestWorker = yield* Effect.forever(
			Queue.take(requestQueue).pipe(
				Effect.flatMap((message) => {
					inFlight.current = message;
					return dispatcher.handleClient(message).pipe(
						Effect.andThen(
							Effect.sync(() => {
								inFlight.current = undefined;
							}),
						),
					);
				}),
			),
		).pipe(Effect.forkScoped);
		const lifecycleWorker = yield* Effect.forever(
			Queue.take(lifecycleQueue).pipe(
				Effect.flatMap(dispatcher.handleLifecycle),
			),
		).pipe(Effect.forkScoped);
		const rejectRequest = (message: ClientRequestMessage) =>
			Effect.gen(function* () {
				const error = new DaemonError({ message: SHUTTING_DOWN_MESSAGE });
				if (message.reply !== undefined)
					yield* Deferred.fail(message.reply, error);
				if (message.socket !== undefined)
					yield* fail(
						message.socket,
						yield* requestIdOf(message.incoming),
						error,
					);
			});
		const closeSocket = (socket: Socket) =>
			Effect.suspend(() => {
				const state = sockets.get(socket);
				return state === undefined
					? Effect.void
					: state.writer.awaitIdle.pipe(
							Effect.timeoutOption(SHUTDOWN_REPLY_FLUSH_TIMEOUT_MS),
							Effect.asVoid,
						);
			}).pipe(
				Effect.andThen(Effect.sync(() => socket.destroy())),
				Effect.andThen(subscriptions.releaseSocket(socket)),
			);
		const server = createServer((socket) => {
			const writer = makeSocketWriter(socket, {
				onOverflow: () => subscriptions.releaseSocketOwnership(socket),
				onClose: () => Effect.runFork(subscriptions.releaseSocket(socket)),
			});
			sockets.set(socket, {
				subscriptions: new Map(),
				writer,
				closed: false,
			});
			let remainder = '';
			const decoder = new StringDecoder('utf8');
			socket.on('data', (chunk) => {
				const state = sockets.get(socket);
				if (state === undefined || state.closed) return;
				const frames = splitFrames(remainder, decoder.write(chunk));
				if (frames._tag === 'TooLarge') {
					socket.destroy();
					return;
				}
				remainder = frames.remainder;
				for (const frame of frames.frames) {
					const message: ClientRequestMessage = {
						_tag: 'request',
						incoming: frame,
						socket,
						reply: undefined,
					};
					if (lifecycle.closing)
						Effect.runFork(
							rejectRequest(message).pipe(Effect.andThen(closeSocket(socket))),
						);
					else enqueueRequest(message);
				}
			});
		});
		yield* Effect.addFinalizer(() =>
			Effect.gen(function* () {
				lifecycle.closing = true;
				yield* stopListening(server, options.socketPath).pipe(
					Effect.catch((cause) => Effect.logError(cause)),
				);
				yield* Fiber.interrupt(requestWorker);
				yield* Fiber.interrupt(lifecycleWorker);
				const unanswered = yield* Queue.clear(requestQueue);
				if (inFlight.current !== undefined)
					unanswered.unshift(inFlight.current);
				yield* Effect.forEach(unanswered, rejectRequest, { discard: true });
				yield* Queue.shutdown(requestQueue);
				yield* Queue.shutdown(lifecycleQueue);
				yield* Effect.forEach(Array.from(sockets.keys()), closeSocket, {
					concurrency: 'unbounded',
					discard: true,
				});
				const stopTimeoutMs =
					options.shutdownTimeoutMs === undefined
						? SHUTDOWN_RUN_STOP_TIMEOUT_MS
						: options.shutdownTimeoutMs;
				const stopped = yield* Effect.gen(function* () {
					const runIds = new Set(
						Array.from(terminals.values(), (live) => live.address.runId),
					);
					for (const runId of runIds)
						yield* runStop
							.stopRun(runId, false)
							.pipe(Effect.catch((cause) => Effect.logError(cause)));
					for (const live of terminals.values())
						yield* runStop
							.terminateRemaining(live)
							.pipe(Effect.catch((cause) => Effect.logError(cause)));
				}).pipe(Effect.timeoutOption(stopTimeoutMs));
				if (Option.isNone(stopped)) {
					yield* Effect.logError(
						`Stopping runs did not finish within ${stopTimeoutMs}ms; killing the remaining process groups`,
					);
					yield* Effect.forEach(
						Array.from(terminals.values()),
						(live) => killProcessGroup(processes, live),
						{ discard: true },
					);
				}
			}),
		);
		yield* listen(server, options.socketPath);
		return Daemon.of({
			request: (incoming: DaemonRequest) =>
				Effect.gen(function* () {
					const response = yield* Deferred.make<unknown, DaemonError>();
					const offered = yield* Queue.offer(requestQueue, {
						_tag: 'request',
						incoming,
						socket: undefined,
						reply: response,
					});
					if (!offered)
						return yield* new DaemonError({
							message: 'Daemon request queue is closed',
						});
					return yield* Deferred.await(response);
				}),
			awaitShutdown: Deferred.await(shutdownRequested),
		});
	});
