import { existsSync, renameSync, statSync, unlinkSync } from 'node:fs';
import {
	createConnection,
	createServer,
	type Server,
	type Socket,
} from 'node:net';
import { join } from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import {
	Context,
	Deferred,
	Effect,
	Exit,
	Fiber,
	Layer,
	Option,
	Queue,
} from 'effect';
import type { FileSystem } from 'effect/FileSystem';
import type { Path } from 'effect/Path';
import type { Scope } from 'effect/Scope';
import devsessPackageJson from '../../package.json' with { type: 'json' };
import { removeOwnPidfile, writeDaemonPidfile } from './bootstrap';
import {
	DaemonAlreadyRunning,
	DaemonError,
	errorMessage,
} from './daemon-errors';
import { Logs } from './logs';
import { makeOutputWorker } from './output-worker';
import { Processes, type ProcessesService } from './processes';
import {
	type DaemonEvent,
	type DaemonInfo,
	type DaemonRequest,
	type DaemonResponse,
	decodeRequest,
	decodeRequestId,
	PROTOCOL_VERSION,
	splitFrames,
} from './protocol';
import { bestEffortPrune, Registry } from './registry';
import {
	type ClientRequestMessage,
	isReadOnlyRequest,
	type LifecycleMessage,
	makeRequestDispatcher,
} from './request-dispatch';
import { makeRunStart } from './run-start';
import { makeRunStop } from './run-stop';
import { selfScriptPath } from './self-invocation';
import { type LiveService, makeServiceState } from './service-state';
import { makeSocketWriter } from './socket-writer';
import { makeSubscriptions, type SocketState } from './subscriptions';

export { DaemonAlreadyRunning, DaemonError } from './daemon-errors';

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

const hasErrnoCode = (cause: unknown, code: string) =>
	cause instanceof Error && 'code' in cause && cause.code === code;

const isAddressInUse = (cause: unknown) => hasErrnoCode(cause, 'EADDRINUSE');

/** A socket file's inode: what tells "the file this daemon bound" from a file someone else put at the same path. */
type SocketIdentity = { readonly dev: bigint; readonly ino: bigint };

const sameIdentity = (
	left: SocketIdentity | undefined,
	right: SocketIdentity | undefined,
) =>
	left !== undefined &&
	right !== undefined &&
	left.dev === right.dev &&
	left.ino === right.ino;

/** `undefined` means nothing exists at the path. */
const readSocketIdentity = (socketPath: string) =>
	Effect.try({
		try: (): SocketIdentity | undefined => {
			try {
				const stats = statSync(socketPath, { bigint: true });
				return { dev: stats.dev, ino: stats.ino };
			} catch (cause) {
				if (hasErrnoCode(cause, 'ENOENT')) return undefined;
				throw cause;
			}
		},
		catch: (cause) =>
			new DaemonError({ message: `Could not stat ${socketPath}`, cause }),
	});

const listenOnce = (server: Server, socketPath: string) =>
	new Promise<void>((resolve, reject) => {
		server.once('error', reject);
		server.listen(socketPath, () => {
			server.off('error', reject);
			resolve();
		});
	});

/** A socket that cannot be reached within the timeout is assumed live, so a daemon that is merely busy is never displaced. */
const socketIsLive = (socketPath: string) =>
	new Promise<boolean>((resolve, reject) => {
		const probe = createConnection(socketPath);
		probe.setTimeout(1_000, () => {
			probe.destroy();
			resolve(true);
		});
		probe.once('connect', () => {
			probe.destroy();
			resolve(true);
		});
		probe.once('error', (cause) => {
			if (
				'code' in cause &&
				(cause.code === 'ECONNREFUSED' || cause.code === 'ENOENT')
			) {
				resolve(false);
				return;
			}
			reject(cause);
		});
	});

const alreadyRunning = (socketPath: string) =>
	new DaemonAlreadyRunning({
		message: `Another daemon is already serving ${socketPath}`,
		socketPath,
	});

/** Run before any startup work: a daemon that is going to lose the socket must not reconcile or prune the registry of the one that holds it. `listen` still checks, for a daemon that binds between this probe and its own bind. */
const failIfSocketServed = (socketPath: string) =>
	Effect.tryPromise({
		try: () => socketIsLive(socketPath),
		catch: (cause) =>
			new DaemonError({ message: `Could not probe ${socketPath}`, cause }),
	}).pipe(
		Effect.flatMap((live) => (live ? alreadyRunning(socketPath) : Effect.void)),
	);

/** Takes over the socket a crashed daemon left behind, so launchd relaunching it after a crash does not fail on EADDRINUSE. */
const listen = (server: Server, socketPath: string) =>
	Effect.tryPromise({
		try: async (): Promise<'bound' | 'served-by-another-daemon'> => {
			try {
				await listenOnce(server, socketPath);
				return 'bound';
			} catch (cause) {
				if (!isAddressInUse(cause)) throw cause;
				if (await socketIsLive(socketPath)) return 'served-by-another-daemon';
				unlinkSync(socketPath);
				await listenOnce(server, socketPath);
				return 'bound';
			}
		},
		catch: (cause) =>
			new DaemonError({ message: `Could not listen at ${socketPath}`, cause }),
	}).pipe(
		Effect.flatMap((outcome) =>
			outcome === 'bound' ? Effect.void : alreadyRunning(socketPath),
		),
	);

/** Bound on stopping runs during shutdown; whatever survives it gets SIGKILL so the daemon always exits. */
export const SHUTDOWN_RUN_STOP_TIMEOUT_MS = 10_000;
/** How often the daemon checks that its socket file is still the one it bound. */
export const SOCKET_WATCH_INTERVAL_MS = 2_000;
const SHUTDOWN_REPLY_FLUSH_TIMEOUT_MS = 1_000;
/** Read-only requests run beside the serial queue; a few workers keep one slow read from starving the rest. */
const READ_WORKER_COUNT = 4;
const SHUTTING_DOWN_MESSAGE = 'Daemon is shutting down';

/** Every listener this daemon created, oldest first, and the identity of the socket file the last one bound. */
type SocketListeners = {
	readonly servers: Array<Server>;
	identity: SocketIdentity;
};

/**
 * Stops accepting connections right away without waiting for open ones to end.
 *
 * Closing a listener makes libuv unlink whatever is at the path it bound, even when someone else
 * put it there, and the same happens to any listener still open when the process exits. So a
 * listener that no longer owns the path is closed while the path's current file is moved out of
 * the way, and moved back right after.
 */
const stopListening = (listeners: SocketListeners, socketPath: string) =>
	readSocketIdentity(socketPath).pipe(
		Effect.flatMap((current) =>
			Effect.try({
				try: () => {
					const newest = listeners.servers.at(-1);
					const owned = sameIdentity(current, listeners.identity);
					const abandoned = listeners.servers.filter(
						(server) => server !== newest || !owned,
					);
					const closeAll = (servers: ReadonlyArray<Server>) => {
						for (const server of servers) if (server.listening) server.close();
					};
					if (current === undefined || abandoned.length === 0)
						closeAll(abandoned);
					else {
						const aside = `${socketPath}.${process.pid}.aside`;
						renameSync(socketPath, aside);
						try {
							closeAll(abandoned);
						} finally {
							if (existsSync(socketPath)) unlinkSync(aside);
							else renameSync(aside, socketPath);
						}
					}
					if (owned && newest !== undefined) closeAll([newest]);
				},
				catch: (cause) =>
					new DaemonError({ message: 'Could not close daemon socket', cause }),
			}),
		),
	);

const killProcessGroup = (processes: ProcessesService, live: LiveService) =>
	processes.kill(live.ownership.identity).pipe(
		Effect.flatMap((killed) =>
			killed
				? Effect.void
				: Effect.logWarning(
						`Not killing process group ${live.ownership.identity.processGroupId}: its leader is gone or changed`,
					),
		),
		Effect.catch((cause) => Effect.logError(cause)),
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
	runStopDeadlineMs?: number;
	overflowDrainTimeoutMs?: number;
	socketWatchIntervalMs?: number;
}): Effect.Effect<
	DaemonService,
	unknown,
	Registry | Logs | Processes | FileSystem | Path | Scope
> =>
	Effect.gen(function* () {
		yield* failIfSocketServed(options.socketPath);
		const scriptPath = selfScriptPath();
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
		const readQueue = yield* Queue.bounded<ClientRequestMessage>(256);
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
		const enqueueRequest = (
			message: ClientRequestMessage,
			queue = requestQueue,
		) => {
			if (Queue.offerUnsafe(queue, message)) return;
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
				Queue.offer(queue, message).pipe(
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
			deadlineMs: options.runStopDeadlineMs,
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
		/** One failed step must not end its loop, or nothing behind it would ever run. */
		const forkLoop = <R>(step: Effect.Effect<void, unknown, R>) =>
			Effect.forever(
				step.pipe(Effect.catchCause((cause) => Effect.logError(cause))),
			).pipe(Effect.forkScoped);
		const forkWorker = <Message, R>(
			queue: Queue.Dequeue<Message>,
			handle: (message: Message) => Effect.Effect<void, unknown, R>,
		) =>
			forkLoop(
				Queue.take(queue).pipe(Effect.flatMap((message) => handle(message))),
			);
		const requestWorker = yield* forkWorker(requestQueue, (message) => {
			inFlight.current = message;
			return dispatcher.handleClient(message).pipe(
				// Cleared even when the handler failed, but not on interruption: shutdown rejects whatever was still in flight.
				Effect.onExit((exit) =>
					Exit.hasInterrupts(exit)
						? Effect.void
						: Effect.sync(() => {
								inFlight.current = undefined;
							}),
				),
			);
		});
		const readWorkers = yield* Effect.forEach(
			Array.from({ length: READ_WORKER_COUNT }),
			() => forkWorker(readQueue, dispatcher.handleClient),
		);
		const lifecycleWorker = yield* forkWorker(
			lifecycleQueue,
			dispatcher.handleLifecycle,
		);
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
		const onConnection = (socket: Socket) => {
			const writer = makeSocketWriter(socket, {
				overflowDrainTimeoutMs: options.overflowDrainTimeoutMs,
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
					else {
						// A daemon busy with a long stop still has to complete handshakes and answer status.
						const decoded = Effect.runSyncExit(decodeRequest(frame));
						if (Exit.isSuccess(decoded) && isReadOnlyRequest(decoded.value))
							enqueueRequest(
								{ ...message, incoming: decoded.value },
								readQueue,
							);
						else enqueueRequest(message);
					}
				}
			});
		};
		const server = createServer(onConnection);
		// Registered before the shutdown finalizer so it runs after it: the pidfile has to
		// outlive a hung shutdown, that is when a client needs it to find this process.
		yield* Effect.addFinalizer(() =>
			removeOwnPidfile(options.socketPath, process.pid).pipe(
				Effect.catch((cause) => Effect.logError(cause)),
			),
		);
		yield* listen(server, options.socketPath);
		const boundIdentity = yield* readSocketIdentity(options.socketPath);
		if (boundIdentity === undefined)
			return yield* new DaemonError({
				message: `Socket ${options.socketPath} was removed right after it was bound`,
			});
		const listeners: SocketListeners = {
			servers: [server],
			identity: boundIdentity,
		};
		// Registered only once this instance owns the socket: a daemon that lost the race must not unlink the winner's.
		yield* Effect.addFinalizer(() =>
			Effect.gen(function* () {
				lifecycle.closing = true;
				yield* stopListening(listeners, options.socketPath).pipe(
					Effect.catch((cause) => Effect.logError(cause)),
				);
				yield* Fiber.interrupt(requestWorker);
				yield* Fiber.interrupt(lifecycleWorker);
				yield* Effect.forEach(readWorkers, Fiber.interrupt, { discard: true });
				const unanswered = [
					...(yield* Queue.clear(requestQueue)),
					...(yield* Queue.clear(readQueue)),
				];
				if (inFlight.current !== undefined)
					unanswered.unshift(inFlight.current);
				yield* Effect.forEach(unanswered, rejectRequest, { discard: true });
				yield* Queue.shutdown(requestQueue);
				yield* Queue.shutdown(readQueue);
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
		// Forked after the shutdown finalizer is registered, so scope close interrupts it first and it cannot re-bind mid-shutdown.
		const socketWatch = { abandoned: false };
		const abandonSocket = Effect.logWarning(
			`Socket ${options.socketPath} now belongs to another process; shutting down without touching it`,
		).pipe(
			Effect.andThen(
				Effect.sync(() => {
					socketWatch.abandoned = true;
				}),
			),
			Effect.andThen(requestShutdown),
		);
		/** Open client connections are bound to the old listener, not to the path, so they keep working. */
		const rebindSocket = Effect.tryPromise({
			try: async (): Promise<'bound' | 'taken'> => {
				const replacement = createServer(onConnection);
				try {
					await listenOnce(replacement, options.socketPath);
				} catch (cause) {
					if (isAddressInUse(cause)) return 'taken';
					throw cause;
				}
				listeners.servers.push(replacement);
				return 'bound';
			},
			catch: (cause) =>
				new DaemonError({
					message: `Could not re-bind ${options.socketPath}`,
					cause,
				}),
		});
		const watchSocket = Effect.gen(function* () {
			yield* Effect.sleep(
				options.socketWatchIntervalMs === undefined
					? SOCKET_WATCH_INTERVAL_MS
					: options.socketWatchIntervalMs,
			);
			if (socketWatch.abandoned) return;
			const current = yield* readSocketIdentity(options.socketPath);
			if (current === undefined) {
				if ((yield* rebindSocket) === 'taken') return yield* abandonSocket;
				const rebound = yield* readSocketIdentity(options.socketPath);
				if (rebound === undefined)
					return yield* new DaemonError({
						message: `Socket ${options.socketPath} was removed right after it was re-bound`,
					});
				listeners.identity = rebound;
				return yield* Effect.logInfo(
					`Socket ${options.socketPath} was missing; re-bound it`,
				);
			}
			if (!sameIdentity(current, listeners.identity))
				return yield* abandonSocket;
		});
		yield* forkLoop(watchSocket);
		yield* writeDaemonPidfile(options.socketPath);
		return Daemon.of({
			request: (incoming: DaemonRequest) =>
				Effect.gen(function* () {
					const response = yield* Deferred.make<unknown, DaemonError>();
					const offered = yield* Queue.offer(
						isReadOnlyRequest(incoming) ? readQueue : requestQueue,
						{
							_tag: 'request',
							incoming,
							socket: undefined,
							reply: response,
						},
					);
					if (!offered)
						return yield* new DaemonError({
							message: 'Daemon request queue is closed',
						});
					return yield* Deferred.await(response);
				}),
			awaitShutdown: Deferred.await(shutdownRequested),
		});
	});
