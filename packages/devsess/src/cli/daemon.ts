import { createServer, type Server, type Socket } from 'node:net';
import { StringDecoder } from 'node:string_decoder';
import {
	Context,
	Deferred,
	Effect,
	Exit,
	Fiber,
	Layer,
	Queue,
	Schema,
} from 'effect';
import type { FileSystem } from 'effect/FileSystem';
import type { Path } from 'effect/Path';
import type { Scope } from 'effect/Scope';
import type { IPty } from 'node-pty';
import {
	type ServiceExit,
	serviceExitCode,
	UNKNOWN_EXIT_CODE,
} from './exit-status';
import { type LogAddress, Logs } from './logs';
import { type LiveProcessOwnership, Processes } from './processes';
import {
	type DaemonEvent,
	type DaemonRequest,
	type DaemonResponse,
	decodeRequest,
	decodeRequestId,
	PROTOCOL_VERSION,
	splitFrames,
} from './protocol';
import { createPty, resizePty, writePty } from './pty';
import {
	isActive,
	Registry,
	type RunRecord,
	refreshService,
	type ServiceRecord,
	type ServiceState,
} from './registry';
import { makeSocketWriter, type SocketWriter } from './socket-writer';
import { TERMINATION_TERM_SIGNAL } from './termination';

export class DaemonError extends Schema.TaggedErrorClass<DaemonError>()(
	'DaemonError',
	{
		message: Schema.String,
		cause: Schema.optional(Schema.Defect()),
	},
) {}

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

type LiveService = {
	readonly terminal: IPty;
	readonly address: LogAddress;
	readonly ownership: LiveProcessOwnership;
	exit: ServiceExit | undefined;
	lease:
		| { readonly id: string; readonly socket: Socket | undefined }
		| undefined;
};
type Subscription = {
	readonly address: LogAddress;
	readonly flush: Effect.Effect<void>;
	readonly unsubscribe: Effect.Effect<void>;
};
type SocketState = {
	readonly subscriptions: Map<string, Subscription>;
	readonly writer: SocketWriter;
};
type RequestMessage =
	| {
			readonly _tag: 'request';
			readonly incoming: DaemonRequest | string;
			readonly socket: Socket | undefined;
			readonly reply: Deferred.Deferred<unknown, DaemonError> | undefined;
	  }
	| { readonly _tag: 'closed'; readonly socket: Socket }
	| {
			readonly _tag: 'exited';
			readonly address: LogAddress;
			readonly exitCode: number;
			readonly signal?: number;
	  }
	| {
			readonly _tag: 'persistenceFailure';
			readonly address: LogAddress;
			readonly cause: unknown;
	  };

type OutputState = {
	readonly address: LogAddress;
	readonly terminal: IPty;
	readonly queue: Queue.Queue<void>;
	readonly pendingWaiters: Set<Deferred.Deferred<void>>;
	pending: string;
	pendingBytes: number;
	processing: boolean;
	paused: boolean;
	closed: boolean;
	failed: boolean;
	failureQueued: boolean;
	worker: Fiber.Fiber<void, unknown> | undefined;
};

const MAX_OUTPUT_BACKLOG_BYTES = 256 * 1024;

const serviceKey = (address: LogAddress) =>
	`${address.runId}:${address.serviceName}`;
const parseShellCommand = (command: string) =>
	['/bin/sh', ['-c', command]] as const;
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

const orphanRemedy = (
	run: RunRecord,
	service: ServiceRecord,
	processGroupId: number,
) =>
	`Service ${service.name} in run ${run.runId} (${run.projectName}/${run.presetName}) has an unverified process group ${processGroupId}. Run \`kill -TERM -${processGroupId}\` manually, or run \`devsess stop --force\` to terminate it and unblock the preset.`;

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
		const requestQueue = yield* Queue.bounded<RequestMessage>(256);
		const terminals = new Map<string, LiveService>();
		const outputs = new Map<string, OutputState>();
		const sockets = new Map<Socket, SocketState>();
		const lifecycle = { closing: false };
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
		const settleOutputWaiters = (output: OutputState) => {
			if (output.processing || output.pendingBytes > 0) return Effect.void;
			const waiters = Array.from(output.pendingWaiters);
			output.pendingWaiters.clear();
			return Effect.forEach(
				waiters,
				(waiter) => Deferred.succeed(waiter, undefined),
				{ discard: true },
			);
		};
		const awaitOutputIdle = (address: LogAddress) =>
			Effect.suspend(() => {
				const output = outputs.get(serviceKey(address));
				if (
					output === undefined ||
					(!output.processing && output.pendingBytes === 0)
				)
					return Effect.void;
				return Effect.gen(function* () {
					const waiter = yield* Deferred.make<void>();
					output.pendingWaiters.add(waiter);
					yield* settleOutputWaiters(output);
					yield* Deferred.await(waiter);
				});
			});
		const closeOutput = (address: LogAddress) =>
			Effect.suspend(() => {
				const key = serviceKey(address);
				const output = outputs.get(key);
				if (output === undefined) return Effect.void;
				output.closed = true;
				output.pending = '';
				output.pendingBytes = 0;
				return settleOutputWaiters(output).pipe(
					Effect.andThen(
						output.worker === undefined
							? Effect.void
							: Fiber.interrupt(output.worker),
					),
					Effect.tap(() =>
						Effect.sync(() => {
							outputs.delete(key);
						}),
					),
				);
			});
		const enqueueOutput = (address: LogAddress, data: string) => {
			const output = outputs.get(serviceKey(address));
			if (output === undefined || output.closed || output.failed) return;
			output.pending += data;
			output.pendingBytes += Buffer.byteLength(data);
			if (output.pendingBytes > MAX_OUTPUT_BACKLOG_BYTES && !output.paused) {
				output.paused = true;
				output.terminal.pause();
			}
			Queue.offerUnsafe(output.queue, undefined);
		};
		const startOutput = (address: LogAddress, terminal: IPty) =>
			Effect.gen(function* () {
				const queue = yield* Queue.bounded<void>(1);
				const output: OutputState = {
					address,
					terminal,
					queue,
					pendingWaiters: new Set(),
					pending: '',
					pendingBytes: 0,
					processing: false,
					paused: false,
					closed: false,
					failed: false,
					failureQueued: false,
					worker: undefined,
				};
				outputs.set(serviceKey(address), output);
				const worker = yield* Effect.forever(
					Queue.take(queue).pipe(
						Effect.flatMap(() => {
							if (output.closed || output.failed) return Effect.void;
							const data = output.pending;
							output.pending = '';
							output.pendingBytes = 0;
							if (data === '') return settleOutputWaiters(output);
							output.processing = true;
							return logs.append(address, data).pipe(
								Effect.asVoid,
								Effect.catch((cause) =>
									Effect.sync(() => {
										output.failed = true;
										output.pending = '';
										output.pendingBytes = 0;
										if (!output.failureQueued) {
											output.failureQueued = true;
											Queue.offerUnsafe(requestQueue, {
												_tag: 'persistenceFailure',
												address,
												cause,
											});
										}
									}),
								),
								Effect.ensuring(
									Effect.sync(() => {
										output.processing = false;
										if (
											output.paused &&
											output.pendingBytes <= MAX_OUTPUT_BACKLOG_BYTES / 2
										) {
											output.paused = false;
											output.terminal.resume();
										}
									}).pipe(
										Effect.andThen(
											Effect.suspend(() => settleOutputWaiters(output)),
										),
									),
								),
							);
						}),
					),
				).pipe(Effect.forkScoped);
				output.worker = worker;
				return output;
			});
		const replaceService = (
			address: LogAddress,
			state: ServiceState,
			exit?: ServiceExit,
		) => {
			const completionStatus =
				state === 'exited' || state === 'failed'
					? ('unknown' as const)
					: undefined;
			return registry.get(address.runId).pipe(
				Effect.flatMap((run) => {
					const services = run.services.map((service) =>
						service.name === address.serviceName
							? exit === undefined
								? { ...service, state, exitStatus: completionStatus }
								: {
										...service,
										state,
										exitCode: exit.exitCode,
										signal: exit.signal,
										exitStatus: undefined,
									}
							: service,
					);
					return registry.replace({
						...run,
						services,
						state: aggregateState(services),
					});
				}),
			);
		};
		const refreshServiceRecord = (
			service: ServiceRecord,
			verifyOwnership: boolean,
		) => {
			if (service.process === undefined)
				return Effect.succeed(refreshService(service, 'missing'));
			const process = service.process;
			if (!verifyOwnership)
				return processes
					.groupAlive(process.processGroupId)
					.pipe(
						Effect.map((alive) =>
							refreshService(service, alive ? 'alive' : 'dead'),
						),
					);
			return processes
				.owns(process)
				.pipe(
					Effect.flatMap((owned) =>
						owned
							? Effect.succeed(refreshService(service, 'owned'))
							: processes
									.groupAlive(process.processGroupId)
									.pipe(
										Effect.map((alive) =>
											refreshService(service, alive ? 'alive' : 'dead'),
										),
									),
					),
				);
		};
		const releaseSocket = (socket: Socket) =>
			Effect.gen(function* () {
				const state = sockets.get(socket);
				if (state !== undefined) {
					state.writer.close();
					for (const subscription of state.subscriptions.values())
						yield* subscription.unsubscribe;
					state.subscriptions.clear();
					sockets.delete(socket);
				}
				for (const live of terminals.values())
					if (live.lease?.socket === socket) live.lease = undefined;
			});
		const completedExit = (service: ServiceRecord): ServiceExit | undefined => {
			if (service.state !== 'exited' && service.state !== 'failed')
				return undefined;
			if (service.exitCode !== undefined)
				return { exitCode: service.exitCode, signal: service.signal };
			return { exitCode: UNKNOWN_EXIT_CODE };
		};
		const finishSubscription = (
			socket: Socket,
			state: SocketState,
			requestId: string,
			subscription: Subscription,
			exit: ServiceExit,
		) =>
			subscription.flush.pipe(
				Effect.andThen(
					send(socket, {
						version: PROTOCOL_VERSION,
						requestId,
						event: 'exit',
						exitCode: exit.exitCode,
						signal: exit.signal,
					}),
				),
				Effect.andThen(subscription.unsubscribe),
				Effect.tap(() =>
					Effect.sync(() => {
						state.subscriptions.delete(requestId);
					}),
				),
			);
		const subscribe = (
			socket: Socket,
			requestId: string,
			address: LogAddress,
			after: number,
			exit?: ServiceExit,
		) =>
			Effect.gen(function* () {
				const state = sockets.get(socket);
				if (state === undefined) return;
				const subscription = yield* logs.replayAndSubscribe(
					address,
					after,
					(event) =>
						send(socket, {
							version: PROTOCOL_VERSION,
							requestId,
							event: 'output',
							data: event.data,
							offset: event.offset,
						}).pipe(Effect.catch(() => Effect.void)),
				);
				for (const event of subscription.replay)
					yield* send(socket, {
						version: PROTOCOL_VERSION,
						requestId,
						event: 'output',
						data: event.data,
						offset: event.offset,
					});
				state.subscriptions.set(requestId, {
					address,
					flush: subscription.flush,
					unsubscribe: subscription.unsubscribe,
				});
				if (exit !== undefined) {
					const current = state.subscriptions.get(requestId);
					if (current !== undefined)
						yield* finishSubscription(socket, state, requestId, current, exit);
				}
			});
		const finishSubscriptions = (address: LogAddress, exit: ServiceExit) =>
			Effect.forEach(
				Array.from(sockets.entries()),
				(entry) => {
					const socket = entry[0];
					const state = entry[1];
					return Effect.forEach(
						Array.from(state.subscriptions.entries()),
						(subscriptionEntry) => {
							const requestId = subscriptionEntry[0];
							const subscription = subscriptionEntry[1];
							if (serviceKey(subscription.address) !== serviceKey(address))
								return Effect.void;
							return finishSubscription(
								socket,
								state,
								requestId,
								subscription,
								exit,
							);
						},
						{ discard: true },
					);
				},
				{ discard: true },
			);
		const stoppedExit = (
			live: LiveService | undefined,
			terminationSignal?: number,
		): ServiceExit =>
			live === undefined || live.exit === undefined
				? {
						exitCode: 0,
						signal:
							terminationSignal === undefined
								? TERMINATION_TERM_SIGNAL
								: terminationSignal,
					}
				: live.exit;
		const reconcile = registry.list.pipe(
			Effect.flatMap((runs) =>
				Effect.forEach(runs, (run) => {
					if (
						!run.services.some(
							(service) =>
								isActive(service.state) || service.state === 'orphaned',
						)
					)
						return Effect.void;
					return Effect.forEach(run.services, (service) =>
						refreshServiceRecord(service, true),
					).pipe(
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
				for (const candidate of existing) {
					if (
						candidate.projectName !== request.params.projectName ||
						candidate.presetName !== request.params.presetName
					)
						continue;
					const refreshedServices = yield* Effect.forEach(
						candidate.services,
						(service) => refreshServiceRecord(service, false),
					);
					const refreshed = {
						...candidate,
						services: refreshedServices,
						state: aggregateState(refreshedServices),
					};
					const orphan = refreshed.services.find(
						(service) =>
							service.state === 'orphaned' && service.process !== undefined,
					);
					if (orphan !== undefined) {
						const process = orphan.process;
						if (process === undefined)
							return yield* Effect.die(
								'An orphaned service must retain its process identity',
							);
						return yield* new DaemonError({
							message: `Cannot start ${candidate.projectName}/${candidate.presetName}: ${orphanRemedy(candidate, orphan, process.processGroupId)}`,
						});
					}
					if (
						refreshed.services.some(
							(service) =>
								isActive(service.state) || service.state === 'orphaned',
						)
					) {
						return yield* new DaemonError({
							message: `Run ${candidate.runId} still has an active service`,
						});
					}
					for (const service of refreshed.services) {
						if (
							service.process !== undefined &&
							(yield* processes.groupAlive(service.process.processGroupId))
						) {
							return yield* new DaemonError({
								message: `Run ${candidate.runId} still owns a service process`,
							});
						}
					}
					if (
						refreshed.services.some(
							(service, index) =>
								service.state !== candidate.services[index]?.state,
						)
					)
						yield* registry.replace(refreshed);
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
				const rollback = Effect.gen(function* () {
					const stopped = yield* stopRun(run.runId, false);
					const services = stopped.services.map((service) => ({
						...service,
						state: 'failed' as const,
					}));
					return yield* registry.replace({
						...stopped,
						services,
						state: 'failed',
					});
				});
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
						const address = { runId: run.runId, serviceName: service.name };
						let observedExit: ServiceExit | undefined;
						yield* startOutput(address, terminal);
						terminal.onData((data) => {
							enqueueOutput(address, data);
						});
						terminal.onExit((event) => {
							const exit: ServiceExit = {
								exitCode: event.exitCode,
								signal: event.signal,
							};
							observedExit = exit;
							const live = terminals.get(serviceKey(address));
							if (live !== undefined) live.exit = exit;
							Queue.offerUnsafe(requestQueue, {
								_tag: 'exited',
								address,
								exitCode: exit.exitCode,
								signal: exit.signal,
							});
						});
						const captured = yield* Effect.exit(
							processes.captureLive(terminal.pid),
						);
						if (Exit.isFailure(captured)) {
							if (observedExit !== undefined) {
								yield* awaitOutputIdle(address);
								yield* closeOutput(address);
								yield* replaceService(
									address,
									serviceExitCode(observedExit) === 0 ? 'exited' : 'failed',
									observedExit,
								);
								continue;
							}
							yield* Effect.try({
								try: () => terminal.kill('SIGKILL'),
								catch: (cause) =>
									new DaemonError({
										message: `Could not roll back unrecorded PTY ${service.name}`,
										cause,
									}),
							}).pipe(
								Effect.catch((error) =>
									error.cause instanceof Error &&
									(error.cause as NodeJS.ErrnoException).code === 'ESRCH'
										? Effect.void
										: error,
								),
							);
							yield* closeOutput(address);
							return yield* Effect.failCause(captured.cause);
						}
						const ownership = captured.value;
						const live: LiveService = {
							address,
							terminal,
							ownership,
							exit: observedExit,
							lease: undefined,
						};
						terminals.set(serviceKey(address), live);
						yield* Effect.gen(function* () {
							const stored = yield* registry.get(run.runId);
							const services = stored.services.map((candidate) =>
								candidate.name === service.name
									? {
											...candidate,
											process: ownership.identity,
											state: 'running' as const,
										}
									: candidate,
							);
							yield* registry.replace({
								...stored,
								services,
								state: aggregateState(services),
							});
						}).pipe(
							Effect.catch((cause) =>
								ownership.terminate.pipe(
									Effect.tap(() =>
										Effect.sync(() => terminals.delete(serviceKey(address))),
									),
									Effect.andThen(Effect.fail(cause)),
								),
							),
						);
					}
					return yield* registry.get(run.runId);
				}).pipe(
					Effect.catch((cause) =>
						rollback.pipe(Effect.andThen(Effect.fail(cause))),
					),
				);
			}).pipe(Effect.uninterruptible);
		const stopRun = (runId: string, force: boolean) =>
			Effect.gen(function* () {
				const run = yield* registry.get(runId);
				const orphanedServices = new Set(
					run.services
						.filter((service) => service.state === 'orphaned')
						.map((service) => service.name),
				);
				const stopping = run.services.map((service) =>
					isActive(service.state) || service.state === 'orphaned'
						? { ...service, state: 'stopping' as const }
						: service,
				);
				const failures: Array<unknown> = [];
				const persisted = yield* Effect.exit(
					registry.replace({
						...run,
						services: stopping,
						state: aggregateState(stopping),
					}),
				);
				if (Exit.isFailure(persisted)) failures.push(persisted.cause);
				const failureMessages: Array<string> = [];
				const services = yield* Effect.forEach(stopping, (service) =>
					Effect.gen(function* () {
						const address = { runId, serviceName: service.name };
						const live = terminals.get(serviceKey(address));
						if (
							live === undefined &&
							!isActive(service.state) &&
							service.state !== 'orphaned'
						)
							return service;
						const identity =
							live === undefined ? service.process : live.ownership.identity;
						if (identity === undefined) {
							if (service.state !== 'stopping') return service;
							const exit = stoppedExit(live);
							yield* finishSubscriptions(address, exit);
							return {
								...service,
								state: 'exited' as const,
								exitCode: exit.exitCode,
								signal: exit.signal,
								exitStatus: undefined,
							};
						}
						const result = yield* Effect.exit(
							live === undefined
								? processes
										.groupAlive(identity.processGroupId)
										.pipe(
											Effect.flatMap((alive) =>
												alive || force
													? processes.terminate(identity, force)
													: Effect.succeed(undefined),
											),
										)
								: live.ownership.terminate,
						);
						if (Exit.isFailure(result)) {
							failures.push(result.cause);
							if (
								!force &&
								live === undefined &&
								orphanedServices.has(service.name)
							)
								failureMessages.push(
									orphanRemedy(run, service, identity.processGroupId),
								);
							return {
								...service,
								process: identity,
								state:
									live === undefined
										? ('orphaned' as const)
										: ('stopping' as const),
							};
						}
						terminals.delete(serviceKey(address));
						yield* closeOutput(address);
						const terminationSignal = Exit.isSuccess(result)
							? result.value
							: undefined;
						const exit = stoppedExit(live, terminationSignal);
						yield* finishSubscriptions(address, exit);
						return {
							...service,
							state:
								service.state === 'failed'
									? ('failed' as const)
									: ('exited' as const),
							exitCode: exit.exitCode,
							signal: exit.signal,
							exitStatus: undefined,
						};
					}),
				);
				const stored = yield* registry.replace({
					...run,
					services,
					state: aggregateState(services),
				});
				if (failures.length > 0) {
					const message =
						failureMessages.length > 0
							? `Could not stop all services in run ${runId}.\n${failureMessages.join('\n')}`
							: `Could not stop all services in run ${runId}`;
					return yield* new DaemonError({
						message,
						cause: failures,
					});
				}
				return stored;
			});
		const processRequest = (
			incoming: DaemonRequest,
			socket: Socket | undefined,
		): Effect.Effect<unknown, unknown, FileSystem | Path | Scope> => {
			if (incoming.method === 'listRuns') return registry.list;
			if (incoming.method === 'startRun') return startRun(incoming);
			if (incoming.method === 'stopRun')
				return stopRun(incoming.params.runId, incoming.params.force === true);
			const address = {
				runId: incoming.params.runId,
				serviceName: incoming.params.serviceName,
			};
			if (incoming.method === 'tail')
				return socket === undefined
					? registry.get(address.runId)
					: Effect.gen(function* () {
							const run = yield* registry.get(address.runId);
							const service = run.services.find(
								(candidate) => candidate.name === address.serviceName,
							);
							if (service === undefined)
								return yield* new DaemonError({
									message: `Service ${address.serviceName} was not found in run ${address.runId}`,
								});
							return yield* subscribe(
								socket,
								incoming.requestId,
								address,
								incoming.params.after ?? 0,
								completedExit(service),
							).pipe(Effect.as({}));
						});
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
		const handle = (message: RequestMessage) => {
			if (message._tag === 'closed') return releaseSocket(message.socket);
			if (message._tag === 'persistenceFailure')
				return Effect.logError(message.cause).pipe(Effect.asVoid);
			if (message._tag === 'exited') {
				const key = serviceKey(message.address);
				const live = terminals.get(key);
				if (live === undefined) return Effect.void;
				const exit: ServiceExit = {
					exitCode: message.exitCode,
					signal: message.signal,
				};
				return awaitOutputIdle(message.address).pipe(
					Effect.andThen(live.ownership.terminate),
					Effect.andThen(
						replaceService(
							message.address,
							serviceExitCode(exit) === 0 ? 'exited' : 'failed',
							exit,
						),
					),
					Effect.tap(() => Effect.sync(() => terminals.delete(key))),
					Effect.andThen(finishSubscriptions(message.address, exit)),
					Effect.andThen(closeOutput(message.address)),
					Effect.asVoid,
					Effect.catch((cause) =>
						replaceService(message.address, 'orphaned', exit).pipe(
							Effect.andThen(finishSubscriptions(message.address, exit)),
							Effect.andThen(closeOutput(message.address)),
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
						Effect.flatMap((id) => fail(socket, id, cause)),
					);
				}),
			);
		};
		const worker = yield* Effect.forever(
			Queue.take(requestQueue).pipe(Effect.flatMap(handle)),
		).pipe(Effect.forkScoped);
		const server = createServer((socket) => {
			if (lifecycle.closing) {
				socket.destroy();
				return;
			}
			const writer = makeSocketWriter(socket, {
				onClose: () =>
					Queue.offerUnsafe(requestQueue, { _tag: 'closed', socket }),
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
					Queue.offerUnsafe(requestQueue, {
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
					yield* releaseSocket(socket);
				}
				const runIds = new Set(
					Array.from(terminals.values(), (live) => live.address.runId),
				);
				for (const runId of runIds)
					yield* stopRun(runId, false).pipe(
						Effect.catch((cause) => Effect.logError(cause)),
					);
				for (const live of terminals.values())
					yield* live.ownership.terminate.pipe(
						Effect.flatMap((terminationSignal) =>
							replaceService(
								live.address,
								'exited',
								stoppedExit(live, terminationSignal),
							),
						),
						Effect.catch((cause) => Effect.logError(cause)),
					);
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
