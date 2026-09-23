import { Effect, Exit } from 'effect';
import type { FileSystem } from 'effect/FileSystem';
import type { Path } from 'effect/Path';
import type { Scope } from 'effect/Scope';
import { DaemonError } from './daemon-errors';
import type { ServiceExit } from './exit-status';
import type { LogAddress } from './logs';
import type { OutputWorker } from './output-worker';
import type { ProcessesService } from './processes';
import { isActive, type RegistryService, type RunRecord } from './registry';
import {
	aggregateState,
	type LiveService,
	orphanRemedy,
	serviceKey,
	stoppedExit,
} from './service-state';
import type { Subscriptions } from './subscriptions';

export type RunStop = {
	readonly finishService: (
		address: LogAddress,
		exit: ServiceExit,
	) => Effect.Effect<void, unknown, FileSystem | Path | Scope>;
	readonly stopRun: (
		runId: string,
		force: boolean,
		failedAddress?: LogAddress,
	) => Effect.Effect<RunRecord, unknown, FileSystem | Path | Scope>;
	readonly terminateRemaining: (
		live: LiveService,
	) => Effect.Effect<RunRecord, unknown, FileSystem | Path | Scope>;
};

export const makeRunStop = (options: {
	readonly registry: RegistryService;
	readonly processes: ProcessesService;
	readonly terminals: Map<string, LiveService>;
	readonly output: OutputWorker;
	readonly subscriptions: Subscriptions;
}): RunStop => {
	const finishService = (address: LogAddress, exit: ServiceExit) =>
		options.output
			.awaitIdle(address)
			.pipe(
				Effect.andThen(options.output.close(address)),
				Effect.andThen(
					options.subscriptions.finishSubscriptions(address, exit),
				),
			);
	const stopRun = (runId: string, force: boolean, failedAddress?: LogAddress) =>
		Effect.gen(function* () {
			const run = yield* options.registry.get(runId);
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
				options.registry.replace({
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
						yield* finishService(address, exit);
						return {
							...service,
							state: failed ? ('failed' as const) : ('exited' as const),
							published: undefined,
							exitCode: exit.exitCode,
							signal: exit.signal,
							exitStatus: undefined,
						};
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
					yield* finishService(address, exit);
					return {
						...service,
						state: failed ? ('failed' as const) : ('exited' as const),
						published: undefined,
						exitCode: exit.exitCode,
						signal: exit.signal,
						exitStatus: undefined,
					};
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
	const terminateRemaining = (live: LiveService) =>
		Effect.gen(function* () {
			const terminationSignal = yield* live.ownership.terminate;
			const exit = stoppedExit(live, terminationSignal);
			options.terminals.delete(serviceKey(live.address));
			yield* finishService(live.address, exit);
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
	return { stopRun, terminateRemaining, finishService };
};
