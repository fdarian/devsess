import type { Socket } from 'node:net';
import { Deferred, Effect } from 'effect';
import type { FileSystem } from 'effect/FileSystem';
import type { Path } from 'effect/Path';
import type { Scope } from 'effect/Scope';
import { DaemonError, errorMessage } from './daemon-errors';
import { type ServiceExit, serviceExitCode } from './exit-status';
import type { OutputWorker } from './output-worker';
import { type DaemonRequest, decodeRequest, decodeRequestId } from './protocol';
import { resizePty, writePty } from './pty';
import type { RegistryService } from './registry';
import type { RunStart } from './run-start';
import type { RunStop } from './run-stop';
import {
	completedExit,
	type LiveService,
	type ServiceStateApi,
	serviceKey,
} from './service-state';
import type { SocketState, Subscriptions } from './subscriptions';

export { DaemonError } from './daemon-errors';

export type ClientRequestMessage = {
	readonly _tag: 'request';
	readonly incoming: DaemonRequest | string;
	readonly socket: Socket | undefined;
	readonly reply: Deferred.Deferred<unknown, DaemonError> | undefined;
};

export type LifecycleMessage =
	| { readonly _tag: 'closed'; readonly socket: Socket }
	| {
			readonly _tag: 'exited';
			readonly address: {
				readonly runId: string;
				readonly serviceName: string;
			};
			readonly exitCode: number;
			readonly signal?: number;
	  }
	| {
			readonly _tag: 'persistenceFailure';
			readonly address: {
				readonly runId: string;
				readonly serviceName: string;
			};
			readonly cause: unknown;
	  };

export type DaemonMessage = ClientRequestMessage | LifecycleMessage;

export type RequestDispatcher = {
	readonly processRequest: (
		incoming: DaemonRequest,
		socket: Socket | undefined,
	) => Effect.Effect<unknown, unknown, FileSystem | Path | Scope>;
	readonly handleClient: (
		message: ClientRequestMessage,
	) => Effect.Effect<void, unknown, FileSystem | Path | Scope>;
	readonly handleLifecycle: (
		message: LifecycleMessage,
	) => Effect.Effect<void, unknown, FileSystem | Path | Scope>;
	readonly handle: (
		message: DaemonMessage,
	) => Effect.Effect<void, unknown, FileSystem | Path | Scope>;
};

export const makeRequestDispatcher = (options: {
	readonly registry: RegistryService;
	readonly terminals: Map<string, LiveService>;
	readonly sockets: Map<Socket, SocketState>;
	readonly output: OutputWorker;
	readonly serviceState: ServiceStateApi;
	readonly subscriptions: Subscriptions;
	readonly runStart: RunStart;
	readonly runStop: RunStop;
	readonly reply: (
		socket: Socket,
		requestId: string,
		result: unknown,
	) => Effect.Effect<void>;
	readonly fail: (
		socket: Socket,
		requestId: string,
		cause: unknown,
	) => Effect.Effect<void>;
}): RequestDispatcher => {
	const processRequest = (
		incoming: DaemonRequest,
		socket: Socket | undefined,
	) => {
		if (incoming.method === 'listRuns') return options.registry.list;
		if (incoming.method === 'startRun')
			return options.runStart.startRun(incoming);
		if (incoming.method === 'stopRun')
			return options.runStop.stopRun(
				incoming.params.runId,
				incoming.params.force === true,
			);
		const address = {
			runId: incoming.params.runId,
			serviceName: incoming.params.serviceName,
		};
		if (incoming.method === 'tail')
			return socket === undefined
				? options.registry.get(address.runId)
				: Effect.gen(function* () {
						const run = yield* options.registry.get(address.runId);
						const service = run.services.find(
							(candidate) => candidate.name === address.serviceName,
						);
						if (service === undefined)
							return yield* new DaemonError({
								message: `Service ${address.serviceName} was not found in run ${address.runId}`,
							});
						return yield* options.subscriptions
							.subscribe(
								socket,
								incoming.requestId,
								address,
								incoming.params.after ?? 0,
								completedExit(service),
							)
							.pipe(Effect.as({}));
					});
		const live = options.terminals.get(serviceKey(address));
		if (incoming.method === 'attach') {
			if (live === undefined)
				return Effect.fail(new DaemonError({ message: 'Service is not live' }));
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
				: options.subscriptions
						.subscribe(socket, incoming.requestId, address, 0)
						.pipe(Effect.as({ leaseId }));
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
			return writePty(live.terminal, incoming.params.data).pipe(Effect.as({}));
		return resizePty(
			live.terminal,
			incoming.params.cols,
			incoming.params.rows,
		).pipe(Effect.as({}));
	};
	const handle = (message: DaemonMessage) => {
		if (message._tag === 'closed')
			return options.subscriptions.releaseSocket(message.socket);
		if (message._tag === 'persistenceFailure')
			return options.runStop
				.stopRun(message.address.runId, false, message.address)
				.pipe(
					Effect.catch((cause) => Effect.logError(cause)),
					Effect.asVoid,
				);
		if (message._tag === 'exited') {
			const key = serviceKey(message.address);
			const live = options.terminals.get(key);
			if (live === undefined) return Effect.void;
			const exit: ServiceExit = {
				exitCode: message.exitCode,
				signal: message.signal,
			};
			return options.output.awaitIdle(message.address).pipe(
				Effect.andThen(live.ownership.terminate),
				Effect.andThen(
					options.serviceState.replaceService(
						message.address,
						serviceExitCode(exit) === 0 ? 'exited' : 'failed',
						exit,
					),
				),
				Effect.tap(() =>
					Effect.sync(() => {
						options.terminals.delete(key);
					}),
				),
				Effect.andThen(options.runStop.finishService(message.address, exit)),
				Effect.asVoid,
				Effect.catch((cause) =>
					options.serviceState
						.replaceService(message.address, 'orphaned', exit)
						.pipe(
							Effect.andThen(
								options.runStop.finishService(message.address, exit),
							),
							Effect.andThen(Effect.logError(cause)),
						),
				),
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
							: options.reply(message.socket, incoming.requestId, result),
					),
					Effect.tap((result) =>
						message.reply === undefined
							? Effect.void
							: Deferred.succeed(message.reply, result),
					),
					Effect.catch((cause) =>
						Effect.all(
							[
								message.socket === undefined
									? Effect.void
									: options.fail(message.socket, incoming.requestId, cause),
								message.reply === undefined
									? Effect.void
									: Deferred.fail(
											message.reply,
											new DaemonError({
												message: errorMessage(cause),
												cause,
											}),
										),
							],
							{ discard: true },
						).pipe(Effect.asVoid),
					),
				),
			),
			Effect.catch((cause) => {
				const socket = message.socket;
				if (socket === undefined) return Effect.void;
				const requestId =
					typeof message.incoming === 'string'
						? decodeRequestId(message.incoming).pipe(
								Effect.map((request) => request.requestId),
								Effect.catch(() => Effect.succeed('invalid')),
							)
						: Effect.succeed(message.incoming.requestId);
				return requestId.pipe(
					Effect.flatMap((id) => options.fail(socket, id, cause)),
				);
			}),
		);
	};
	return { processRequest, handle };
};
