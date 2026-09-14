import { createServer, type Server, type Socket } from 'node:net';
import { StringDecoder } from 'node:string_decoder';
import { Context, Deferred, Effect, Fiber, Layer, Queue } from 'effect';
import type { FileSystem } from 'effect/FileSystem';
import type { Path } from 'effect/Path';
import type { Scope } from 'effect/Scope';
import { DaemonError, errorMessage } from './daemon-errors';
import { Logs } from './logs';
import { makeOutputWorker } from './output-worker';
import { Processes } from './processes';
import {
	type DaemonEvent,
	type DaemonRequest,
	type DaemonResponse,
	PROTOCOL_VERSION,
	splitFrames,
} from './protocol';
import { Registry } from './registry';
import { type DaemonMessage, makeRequestDispatcher } from './request-dispatch';
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
};

export class Daemon extends Context.Service<Daemon, DaemonService>()(
	'devsess/cli/Daemon',
) {
	static readonly layer: (options: {
		socketPath: string;
		dataDirectory: string;
		maxLogBytes: number;
	}) => Layer.Layer<Daemon, unknown, FileSystem | Path> = (options) =>
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

export const makeDaemon = (options: {
	socketPath: string;
}): Effect.Effect<
	DaemonService,
	unknown,
	Registry | Logs | Processes | FileSystem | Path | Scope
> =>
	Effect.gen(function* () {
		const registry = yield* Registry;
		const logs = yield* Logs;
		const processes = yield* Processes;
		const daemonIdentity = yield* processes.capture(process.pid);
		const requestQueue = yield* Queue.bounded<DaemonMessage>(256);
		const terminals = new Map<string, LiveService>();
		const sockets = new Map<Socket, SocketState>();
		const lifecycle = { closing: false };
		const enqueueLifecycle = (message: DaemonMessage) => {
			Queue.offerUnsafe(requestQueue, message);
		};
		const send = (socket: Socket, frame: DaemonResponse | DaemonEvent) =>
			Effect.suspend(() => {
				const state = sockets.get(socket);
				return state === undefined ? Effect.void : state.writer.send(frame);
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
			onRelease: (socket) =>
				Effect.sync(() => {
					for (const live of terminals.values())
						if (live.lease?.socket === socket) live.lease = undefined;
				}),
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
			registry,
			processes,
			daemonIdentity,
			terminals,
			output,
			serviceState,
			stopRun: runStop.stopRun,
			onExited: (address, exit) =>
				enqueueLifecycle({
					_tag: 'exited',
					address,
					exitCode: exit.exitCode,
					signal: exit.signal,
				}),
		});
		const dispatcher = makeRequestDispatcher({
			registry,
			terminals,
			sockets,
			output,
			serviceState,
			subscriptions,
			runStart,
			runStop,
			reply,
			fail,
		});
		yield* serviceState.reconcile;
		const worker = yield* Effect.forever(
			Queue.take(requestQueue).pipe(Effect.flatMap(dispatcher.handle)),
		).pipe(Effect.forkScoped);
		const server = createServer((socket) => {
			if (lifecycle.closing) {
				socket.destroy();
				return;
			}
			const writer = makeSocketWriter(socket, {
				onClose: () => enqueueLifecycle({ _tag: 'closed', socket }),
			});
			sockets.set(socket, {
				subscriptions: new Map(),
				writer,
			});
			let remainder = '';
			const decoder = new StringDecoder('utf8');
			socket.on('data', (chunk) => {
				const frames = splitFrames(remainder, decoder.write(chunk));
				if (frames._tag === 'TooLarge') {
					socket.destroy();
					return;
				}
				remainder = frames.remainder;
				for (const frame of frames.frames)
					enqueueLifecycle({
						_tag: 'request',
						incoming: frame,
						socket,
						reply: undefined,
					});
			});
		});
		yield* Effect.addFinalizer(() =>
			Effect.gen(function* () {
				lifecycle.closing = true;
				yield* Fiber.interrupt(worker);
				yield* Queue.shutdown(requestQueue);
				for (const socket of sockets.keys()) {
					socket.destroy();
					yield* subscriptions.releaseSocket(socket);
				}
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
				if (server.listening)
					yield* closeServer(server).pipe(
						Effect.catch((cause) => Effect.logError(cause)),
					);
			}),
		);
		yield* listen(server, options.socketPath);
		return Daemon.of({
			request: (incoming: DaemonRequest) =>
				Effect.gen(function* () {
					const response = yield* Deferred.make<unknown, DaemonError>();
					yield* Queue.offer(requestQueue, {
						_tag: 'request',
						incoming,
						socket: undefined,
						reply: response,
					});
					return yield* Deferred.await(response);
				}),
		});
	});
