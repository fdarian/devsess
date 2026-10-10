import { Cause, Effect, Exit, Option } from 'effect';
import type { FileSystem } from 'effect/FileSystem';
import type { Path } from 'effect/Path';
import type { Scope } from 'effect/Scope';
import type { IPty } from 'node-pty';
import { DaemonError, errorMessage } from './daemon-errors';
import type { ServiceExit } from './exit-status';
import type { LogAddress } from './logs';
import type { OutputWorker } from './output-worker';
import type { ProcessesService, ProcessIdentity } from './processes';
import {
	isActive,
	type RegistryService,
	type RunRecord,
	type ServiceRecord,
} from './registry';
import {
	aggregateState,
	type LiveService,
	orphanRemedy,
	serviceKey,
	stoppedExit,
} from './service-state';
import type { Subscriptions } from './subscriptions';
import {
	FORCE_KILL_SETTLE_TIMEOUT_MS,
	RUN_STOP_DEADLINE_MS,
	TERMINATION_KILL_SIGNAL,
	TERMINATION_POLL_INTERVAL_MS,
} from './termination';

const failureReason = (cause: Cause.Cause<unknown>) =>
	Option.match(Cause.findErrorOption(cause), {
		onNone: () => Cause.pretty(cause),
		onSome: errorMessage,
	});

export type RunStop = {
	readonly finishService: (
		address: LogAddress,
		exit: ServiceExit,
		terminal?: IPty,
	) => Effect.Effect<void, unknown, FileSystem | Path | Scope>;
	readonly stopRun: (
		runId: string,
		force: boolean,
		failedAddress?: LogAddress,
		serviceNames?: ReadonlySet<string>,
	) => Effect.Effect<RunRecord, unknown, FileSystem | Path | Scope>;
	readonly terminateRemaining: (
		live: LiveService,
	) => Effect.Effect<RunRecord, unknown, FileSystem | Path | Scope>;
	/** True only when the group is confirmed gone. The signal-0 probe does not shell out to `ps`, so it still answers while process inspection is failing. */
	readonly groupGone: (identity: ProcessIdentity) => Effect.Effect<boolean>;
};

const completedService = (
	service: ServiceRecord,
	exit: ServiceExit,
	failed: boolean,
): ServiceRecord => ({
	...service,
	state: failed ? 'failed' : 'exited',
	published: undefined,
	exitCode: exit.exitCode,
	signal: exit.signal,
	exitStatus: undefined,
});

type SettledService = {
	readonly record: ServiceRecord;
	readonly failure: string | undefined;
};

export const makeRunStop = (options: {
	readonly registry: RegistryService;
	readonly processes: ProcessesService;
	readonly terminals: Map<string, LiveService>;
	readonly output: OutputWorker;
	readonly subscriptions: Subscriptions;
	readonly deadlineMs?: number;
}): RunStop => {
	const deadlineMs =
		options.deadlineMs === undefined
			? RUN_STOP_DEADLINE_MS
			: options.deadlineMs;
	const groupGone = (identity: ProcessIdentity) =>
		options.processes.groupAlive(identity.processGroupId).pipe(
			Effect.map((alive) => !alive),
			Effect.catch((cause) => Effect.logWarning(cause).pipe(Effect.as(false))),
		);
	const finishService = (
		address: LogAddress,
		exit: ServiceExit,
		terminal?: IPty,
	) =>
		options.output
			.awaitIdle(address, terminal)
			.pipe(
				Effect.andThen(options.output.close(address, terminal)),
				Effect.andThen(
					options.subscriptions.finishSubscriptions(address, exit),
				),
			);
	const stopGracefully = (
		runId: string,
		force: boolean,
		failedAddress?: LogAddress,
		serviceNames?: ReadonlySet<string>,
	) =>
		Effect.gen(function* () {
			const run = yield* options.registry.get(runId);
			const orphanedServices = new Set(
				run.services
					.filter((service) => service.state === 'orphaned')
					.map((service) => service.name),
			);
			const stopping = run.services.map((service) =>
				(serviceNames === undefined || serviceNames.has(service.name)) &&
				(isActive(service.state) || service.state === 'orphaned')
					? { ...service, state: 'stopping' as const }
					: service,
			);
			const failures: Array<unknown> = [];
			const persisted = yield* Effect.exit(
				options.registry.replace({
					...run,
					services: stopping,
					state: aggregateState(stopping),
				}),
			);
			if (Exit.isFailure(persisted)) failures.push(persisted.cause);
			const failureMessages: Array<string> = [];
			if (Exit.isFailure(persisted))
				failureMessages.push(
					`Could not persist stopping state: ${failureReason(persisted.cause)}`,
				);
			const services = yield* Effect.forEach(stopping, (service) =>
				Effect.gen(function* () {
					if (serviceNames !== undefined && !serviceNames.has(service.name))
						return service;
					const address = { runId, serviceName: service.name };
					const live = options.terminals.get(serviceKey(address));
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
						const failed =
							failedAddress !== undefined &&
							serviceKey(failedAddress) === serviceKey(address);
						const exit = failed
							? { exitCode: 1, signal: undefined }
							: stoppedExit(live);
						yield* finishService(address, exit, live?.terminal);
						return completedService(service, exit, failed);
					}
					const result = yield* Effect.exit(
						live === undefined
							? options.processes
									.groupAlive(identity.processGroupId)
									.pipe(
										Effect.flatMap((alive) =>
											alive || force
												? options.processes.terminate(identity, force)
												: Effect.succeed(undefined),
										),
									)
							: live.ownership.terminate,
					);
					if (Exit.isFailure(result)) {
						// A failed inspection says nothing about the process; a group that is provably gone is a stopped service, not a stuck one.
						if (!(yield* groupGone(identity))) {
							failures.push(result.cause);
							failureMessages.push(
								`Service ${service.name}: ${failureReason(result.cause)}`,
							);
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
						yield* Effect.logWarning(
							`Run ${runId} service ${service.name} is recorded as stopped because its process group is gone, although stopping it failed: ${failureReason(result.cause)}`,
						);
					}
					if (options.terminals.get(serviceKey(address)) === live)
						options.terminals.delete(serviceKey(address));
					const terminationSignal = Exit.isSuccess(result)
						? result.value
						: undefined;
					const failed =
						failedAddress !== undefined &&
						serviceKey(failedAddress) === serviceKey(address);
					const exit = failed
						? { exitCode: 1, signal: terminationSignal }
						: stoppedExit(live, terminationSignal);
					yield* finishService(address, exit, live?.terminal);
					return completedService(service, exit, failed);
				}),
			);
			const stored = yield* options.registry.replace({
				...run,
				services,
				state: aggregateState(services),
			});
			for (const service of services) {
				if (service.state !== 'exited' && service.state !== 'failed') continue;
				yield* options.subscriptions.markPersisted({
					runId,
					serviceName: service.name,
				});
			}
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
	const awaitGroupGone = (identity: ProcessIdentity) =>
		Effect.gen(function* () {
			while (!(yield* groupGone(identity)))
				yield* Effect.sleep(`${TERMINATION_POLL_INTERVAL_MS} millis`);
		}).pipe(
			Effect.timeoutOption(FORCE_KILL_SETTLE_TIMEOUT_MS),
			Effect.map(Option.isSome),
		);
	const killUntilGone = (identity: ProcessIdentity) =>
		Effect.gen(function* () {
			if (yield* groupGone(identity)) return 'gone' as const;
			const signalled = yield* options.processes.kill(identity);
			if (!signalled)
				return (yield* groupGone(identity))
					? ('gone' as const)
					: ('unverified' as const);
			return (yield* awaitGroupGone(identity))
				? ('killed' as const)
				: ('survived' as const);
		});
	const settleService = (
		runId: string,
		service: ServiceRecord,
		failedAddress: LogAddress | undefined,
	): Effect.Effect<SettledService, never, FileSystem | Path | Scope> =>
		Effect.gen(function* () {
			const address = { runId, serviceName: service.name };
			const live = options.terminals.get(serviceKey(address));
			const identity =
				live === undefined ? service.process : live.ownership.identity;
			let terminationSignal: number | undefined;
			if (identity !== undefined) {
				const outcome = yield* Effect.exit(killUntilGone(identity));
				if (Exit.isFailure(outcome))
					return {
						record: { ...service, process: identity, state: 'orphaned' },
						failure: `Service ${service.name}: ${failureReason(outcome.cause)}`,
					};
				if (outcome.value === 'unverified' || outcome.value === 'survived')
					return {
						record: { ...service, process: identity, state: 'orphaned' },
						failure:
							outcome.value === 'survived'
								? `Service ${service.name}: process group ${identity.processGroupId} survived SIGKILL`
								: `Service ${service.name}: process group ${identity.processGroupId} is alive but its leader is gone or changed, so it was not killed`,
					};
				if (outcome.value === 'killed')
					terminationSignal = TERMINATION_KILL_SIGNAL;
			}
			if (
				live !== undefined &&
				options.terminals.get(serviceKey(address)) === live
			)
				options.terminals.delete(serviceKey(address));
			const failed =
				failedAddress !== undefined &&
				serviceKey(failedAddress) === serviceKey(address);
			const exit = failed
				? { exitCode: 1, signal: terminationSignal }
				: stoppedExit(live, terminationSignal);
			yield* finishService(address, exit, live?.terminal).pipe(
				Effect.timeoutOption(FORCE_KILL_SETTLE_TIMEOUT_MS),
				Effect.catch((cause) => Effect.logError(cause)),
			);
			return {
				record: completedService(service, exit, failed),
				failure: undefined,
			};
		});
	/** Runs once the graceful stop blew its deadline: kill what is left and record every selected service as ended, so nothing stays `stopping` with dead PIDs. */
	const settleAfterDeadline = (
		runId: string,
		failedAddress: LogAddress | undefined,
		serviceNames: ReadonlySet<string> | undefined,
	) =>
		Effect.gen(function* () {
			yield* Effect.logWarning(
				`Stopping run ${runId} did not finish within ${deadlineMs}ms; killing what remains`,
			);
			const run = yield* options.registry.get(runId);
			const settled = yield* Effect.forEach(
				run.services,
				(
					service,
				): Effect.Effect<SettledService, never, FileSystem | Path | Scope> =>
					(serviceNames === undefined || serviceNames.has(service.name)) &&
					(isActive(service.state) || service.state === 'orphaned')
						? settleService(runId, service, failedAddress)
						: Effect.succeed({ record: service, failure: undefined }),
				{ concurrency: 'unbounded' },
			);
			const services = settled.map((entry) => entry.record);
			const stored = yield* options.registry.replace({
				...run,
				services,
				state: aggregateState(services),
			});
			for (const entry of settled) {
				if (entry.record.state !== 'exited' && entry.record.state !== 'failed')
					continue;
				yield* options.subscriptions.markPersisted({
					runId,
					serviceName: entry.record.name,
				});
			}
			const failures = settled.flatMap((entry) =>
				entry.failure === undefined ? [] : [entry.failure],
			);
			if (failures.length > 0)
				return yield* new DaemonError({
					message: `Could not stop all services in run ${runId} within ${deadlineMs}ms.\n${failures.join('\n')}`,
				});
			return stored;
		});
	const stopRun = (
		runId: string,
		force: boolean,
		failedAddress?: LogAddress,
		serviceNames?: ReadonlySet<string>,
	) =>
		stopGracefully(runId, force, failedAddress, serviceNames).pipe(
			Effect.timeoutOption(deadlineMs),
			Effect.flatMap((stopped) =>
				Option.isSome(stopped)
					? Effect.succeed(stopped.value)
					: settleAfterDeadline(runId, failedAddress, serviceNames),
			),
		);
	const terminateRemaining = (live: LiveService) =>
		Effect.gen(function* () {
			const terminationSignal = yield* live.ownership.terminate;
			const exit = stoppedExit(live, terminationSignal);
			if (options.terminals.get(serviceKey(live.address)) === live)
				options.terminals.delete(serviceKey(live.address));
			yield* finishService(live.address, exit, live.terminal);
			const run = yield* options.registry.get(live.address.runId);
			const services = run.services.map((service) =>
				service.name === live.address.serviceName
					? {
							...service,
							state: 'exited' as const,
							published: undefined,
							exitCode: exit.exitCode,
							signal: exit.signal,
							exitStatus: undefined,
						}
					: service,
			);
			const stored = yield* options.registry.replace({
				...run,
				services,
				state: aggregateState(services),
			});
			yield* options.subscriptions.markPersisted(live.address);
			return stored;
		});
	return { stopRun, terminateRemaining, finishService, groupGone };
};
