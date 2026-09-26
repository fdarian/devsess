import type { Socket } from 'node:net';
import { Deferred, Effect, Exit } from 'effect';
import type { FileSystem } from 'effect/FileSystem';
import type { Path } from 'effect/Path';
import type { Scope } from 'effect/Scope';
import { DaemonError, errorMessage } from './daemon-errors';
import { type ServiceExit, serviceExitCode } from './exit-status';
import type { OutputWorker } from './output-worker';
import { type DaemonRequest, decodeRequest, decodeRequestId } from './protocol';
import { resizePty, writePty } from './pty';
import { isRunActive, type RegistryService } from './registry';
import type { RunStart } from './run-start';
import type { RunStop } from './run-stop';
import {
	aggregateState,
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
	| {
			readonly _tag: 'exited';
			readonly address: {
				readonly runId: string;
				readonly serviceName: string;
			};
			readonly exitCode: number;
			readonly signal?: number;
			readonly pid?: number;
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
	readonly environments: Map<string, Readonly<Record<string, string>>>;
	readonly sockets: Map<Socket, SocketState>;
	readonly output: OutputWorker;
	readonly serviceState: ServiceStateApi;
	readonly subscriptions: Subscriptions;
	readonly runStart: RunStart;
	readonly runStop: RunStop;
	readonly info?: () => Effect.Effect<unknown, unknown, FileSystem | Path>;
	readonly requestShutdown?: Effect.Effect<void>;
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
	const restartingRuns = new Set<string>();
	const forgetFinished = (runId: string) =>
		options.registry.get(runId).pipe(
			Effect.tap((run) =>
				Effect.sync(() => {
					if (!isRunActive(run) && !restartingRuns.has(runId))
						options.environments.delete(runId);
				}),
			),
			Effect.asVoid,
		);
	const processRequest = (
		incoming: DaemonRequest,
		socket: Socket | undefined,
	) => {
		if (socket !== undefined) {
			const state = options.sockets.get(socket);
			if (state === undefined || state.closed)
				return Effect.fail(new DaemonError({ message: 'Socket is closed' }));
		}
		if (incoming.method === 'listRuns')
			return options.serviceState.reconcileFinished.pipe(
				Effect.andThen(options.registry.list),
			);
		if (incoming.method === 'info')
			return options.info === undefined
				? Effect.fail(
						new DaemonError({ message: 'Daemon info is unavailable' }),
					)
				: options.info();
		if (incoming.method === 'shutdown')
			return options.registry.list.pipe(
				Effect.flatMap((runs) => {
					const active = runs.filter(isRunActive);
					if (active.length > 0 && incoming.params.force !== true)
						return Effect.fail(
							new DaemonError({
								message: `Cannot shut down daemon while runs are active: ${active.map((run) => `${run.projectName}/${run.presetName}`).join(', ')}. Use --force to stop them.`,
							}),
						);
					return Effect.forEach(
						active,
						(run) =>
							options.runStop
								.stopRun(run.runId, true)
								.pipe(Effect.tap(() => forgetFinished(run.runId))),
						{ discard: true },
					).pipe(Effect.as({}));
				}),
			);
		if (incoming.method === 'startRun')
			return options.runStart.startRun(incoming);
		if (incoming.method === 'publish' || incoming.method === 'unpublish')
			return Effect.gen(function* () {
				const run = yield* options.registry.get(incoming.params.runId);
				const service = run.services.find(
					(candidate) => candidate.name === incoming.params.service,
				);
				if (service === undefined)
					return yield* new DaemonError({
						message: `Service ${incoming.params.service} was not found in run ${run.runId}`,
					});
				if (
					service.state !== 'running' ||
					!options.terminals.has(
						serviceKey({ runId: run.runId, serviceName: service.name }),
					)
				)
					return yield* new DaemonError({
						message: `Service ${service.name} in run ${run.runId} is not live`,
					});
				const services = run.services.map((candidate) =>
					candidate.name === service.name
						? {
								...candidate,
								published:
									incoming.method === 'publish'
										? {
												value: incoming.params.value,
												publishedAt: new Date().toISOString(),
											}
										: undefined,
							}
						: candidate,
				);
				yield* options.registry.replace({ ...run, services });
				return {};
			});
		if (incoming.method === 'stopRun')
			return options.runStop
				.stopRun(incoming.params.runId, incoming.params.force === true)
				.pipe(Effect.tap(() => forgetFinished(incoming.params.runId)));
		if (incoming.method === 'restartServices')
			return Effect.gen(function* () {
				const run = yield* options.registry.get(incoming.params.runId);
				if (!isRunActive(run))
					return yield* new DaemonError({
						message: `Run ${run.runId} is not active`,
					});
				const names = new Set(incoming.params.serviceNames);
				if (
					names.size === 0 ||
					names.size !== incoming.params.serviceNames.length
				)
					return yield* new DaemonError({
						message: 'Select distinct services to restart',
					});
				for (const name of names) {
					const service = run.services.find(
						(candidate) => candidate.name === name,
					);
					if (service === undefined)
						return yield* new DaemonError({
							message: `Service ${name} was not found in run ${run.runId}`,
						});
				}
				const environment = options.environments.get(run.runId);
				if (environment === undefined)
					return yield* new DaemonError({
						message: `Run ${run.runId} was started by a previous daemon; stop it and start it again to enable restart.`,
					});
				restartingRuns.add(run.runId);
				return yield* Effect.gen(function* () {
					yield* options.runStop.stopRun(run.runId, false, undefined, names);
					for (const name of names) {
						const current = yield* options.registry.get(run.runId);
						const service = current.services.find(
							(candidate) => candidate.name === name,
						);
						if (service === undefined)
							return yield* Effect.die(`Service ${name} disappeared`);
						const services = current.services.map((candidate) =>
							candidate.name === name
								? {
										...candidate,
										state: 'starting' as const,
										process: undefined,
										published: undefined,
										exitCode: undefined,
										signal: undefined,
										exitStatus: undefined,
									}
								: candidate,
						);
						const starting = yield* options.registry.replace({
							...current,
							services,
							state: aggregateState(services),
						});
						yield* options.output.appendMarker(
							{ runId: run.runId, serviceName: name },
							`--- devsess: restarted ${name} ---\n`,
						);
						yield* options.runStart.spawnService(
							starting,
							service,
							environment,
						);
					}
					return yield* options.registry.get(run.runId);
				}).pipe(
					Effect.exit,
					Effect.flatMap((result) =>
						Effect.sync(() => restartingRuns.delete(run.runId)).pipe(
							Effect.andThen(forgetFinished(run.runId)),
							Effect.andThen(
								Exit.isFailure(result)
									? Effect.failCause(result.cause)
									: Effect.succeed(result.value),
							),
						),
					),
				);
			}).pipe(Effect.uninterruptible);
		const address = {
			runId: incoming.params.runId,
			serviceName: incoming.params.serviceName,
		};
		if (incoming.method === 'tail')
			return socket === undefined
				? options.registry.get(address.runId)
				: Effect.sync(() => options.subscriptions.retain(address)).pipe(
						Effect.andThen(
							Effect.gen(function* () {
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
										incoming.params.lines,
										incoming.params.follow !== false,
									)
									.pipe(Effect.as({}));
							}),
						),
						Effect.ensuring(
							Effect.sync(() => options.subscriptions.release(address)),
						),
					);
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
	const handleLifecycle = (message: LifecycleMessage) => {
		if (message._tag === 'persistenceFailure')
			return options.runStop
				.stopRun(message.address.runId, false, message.address)
				.pipe(
					Effect.tap(() => forgetFinished(message.address.runId)),
					Effect.catch((cause) => Effect.logError(cause)),
					Effect.asVoid,
				);
		if (message._tag === 'exited') {
			const key = serviceKey(message.address);
			const live = options.terminals.get(key);
			if (live === undefined) return Effect.void;
			if (message.pid !== undefined && live.terminal.pid !== message.pid)
				return Effect.void;
			const exit: ServiceExit = {
				exitCode: message.exitCode,
				signal: message.signal,
			};
			return live.ownership.terminate.pipe(
				Effect.flatMap(() =>
					options.terminals.get(key) === live
						? options.serviceState.replaceService(
								message.address,
								serviceExitCode(exit) === 0 ? 'exited' : 'failed',
								exit,
								live.ownership.identity.pid,
							)
						: Effect.succeed(undefined),
				),
				Effect.flatMap((updated) =>
					Effect.suspend(() => {
						if (updated === undefined || options.terminals.get(key) !== live)
							return Effect.void;
						options.terminals.delete(key);
						return options.runStop
							.finishService(message.address, exit, live.terminal)
							.pipe(
								Effect.andThen(
									options.subscriptions.markPersisted(message.address),
								),
								Effect.andThen(forgetFinished(message.address.runId)),
							);
					}),
				),
				Effect.asVoid,
				Effect.catch((cause) =>
					(options.terminals.get(key) === live
						? options.serviceState
								.replaceService(
									message.address,
									'orphaned',
									exit,
									live.ownership.identity.pid,
								)
								.pipe(
									Effect.flatMap((updated) =>
										updated === undefined || options.terminals.get(key) !== live
											? Effect.void
											: options.runStop.finishService(
													message.address,
													exit,
													live.terminal,
												),
									),
								)
						: Effect.void
					).pipe(Effect.andThen(Effect.logError(cause))),
				),
			);
		}
		return Effect.void;
	};
	const handleClient = (message: ClientRequestMessage) => {
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
					Effect.tap(() =>
						incoming.method === 'shutdown' &&
						options.requestShutdown !== undefined
							? options.requestShutdown
							: Effect.void,
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
	const handle = (message: DaemonMessage) =>
		message._tag === 'request'
			? handleClient(message)
			: handleLifecycle(message);
	return { processRequest, handle, handleClient, handleLifecycle };
};
