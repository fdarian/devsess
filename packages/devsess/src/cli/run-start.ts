import { Effect, Exit } from 'effect';
import type { FileSystem } from 'effect/FileSystem';
import type { Path } from 'effect/Path';
import type { Scope } from 'effect/Scope';
import { DaemonError } from './daemon-errors';
import { type ServiceExit, serviceExitCode } from './exit-status';
import type { OutputWorker } from './output-worker';
import type { ProcessesService, ProcessIdentity } from './processes';
import type { DaemonRequest } from './protocol';
import { createPty } from './pty';
import type { RegistryService, RunRecord } from './registry';
import {
	aggregateState,
	type LiveService,
	orphanRemedy,
	type ServiceStateApi,
	serviceKey,
} from './service-state';

const parseShellCommand = (command: string) =>
	['/bin/sh', ['-c', command]] as const;

export type RunStart = ReturnType<typeof makeRunStart>;

export const makeRunStart = (options: {
	readonly registry: RegistryService;
	readonly processes: ProcessesService;
	readonly daemonIdentity: ProcessIdentity;
	readonly terminals: Map<string, LiveService>;
	readonly output: OutputWorker;
	readonly serviceState: ServiceStateApi;
	readonly stopRun: (
		runId: string,
		force: boolean,
		failedAddress?: { readonly runId: string; readonly serviceName: string },
	) => Effect.Effect<RunRecord, unknown, FileSystem | Path | Scope>;
	readonly onExited: (
		address: {
			readonly runId: string;
			readonly serviceName: string;
		},
		exit: ServiceExit,
	) => void;
}) => {
	const startRun = (
		request: Extract<DaemonRequest, { readonly method: 'startRun' }>,
	) =>
		Effect.gen(function* () {
			const existing = yield* options.registry.list;
			for (const candidate of existing) {
				if (
					candidate.projectName !== request.params.projectName ||
					candidate.presetName !== request.params.presetName
				)
					continue;
				const refreshedServices = yield* Effect.forEach(
					candidate.services,
					(service) =>
						options.serviceState.refreshServiceRecord(service, false),
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
							service.state === 'starting' ||
							service.state === 'running' ||
							service.state === 'stopping' ||
							service.state === 'orphaned',
					)
				) {
					return yield* new DaemonError({
						message: `Run ${candidate.runId} still has an active service`,
					});
				}
				for (const service of refreshed.services) {
					if (
						service.process !== undefined &&
						(yield* options.processes.groupAlive(
							service.process.processGroupId,
						))
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
					yield* options.registry.replace(refreshed);
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
				daemon: options.daemonIdentity,
				services: request.params.services.map((service) => ({
					name: service.name,
					command: service.command,
					cwd: service.cwd,
					state: 'starting',
				})),
			};
			yield* options.registry.reserve(run);
			const rollback = Effect.gen(function* () {
				const stopped = yield* options.stopRun(run.runId, false);
				const services = stopped.services.map((service) => ({
					...service,
					state: 'failed' as const,
				}));
				return yield* options.registry.replace({
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
					let registeredLive: LiveService | undefined;
					let exitNotified = false;
					yield* options.output.start(address, terminal);
					terminal.onData((data) => {
						options.output.enqueue(address, data);
					});
					terminal.onExit((event) => {
						const exit: ServiceExit = {
							exitCode: event.exitCode,
							signal: event.signal,
						};
						observedExit = exit;
						const live =
							registeredLive ?? options.terminals.get(serviceKey(address));
						if (live === undefined) return;
						live.exit = exit;
						if (exitNotified) return;
						exitNotified = true;
						options.onExited(address, exit);
					});
					const captured = yield* Effect.exit(
						options.processes.captureLive(terminal.pid),
					);
					if (Exit.isFailure(captured)) {
						if (observedExit !== undefined) {
							yield* options.output.awaitIdle(address);
							yield* options.output.close(address);
							yield* options.serviceState.replaceService(
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
						yield* options.output.close(address);
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
					registeredLive = live;
					options.terminals.set(serviceKey(address), live);
					if (observedExit !== undefined && !exitNotified) {
						exitNotified = true;
						options.onExited(address, observedExit);
					}
					yield* Effect.gen(function* () {
						const stored = yield* options.registry.get(run.runId);
						const services = stored.services.map((candidate) =>
							candidate.name === service.name
								? {
										...candidate,
										process: ownership.identity,
										state: 'running' as const,
									}
								: candidate,
						);
						yield* options.registry.replace({
							...stored,
							services,
							state: aggregateState(services),
						});
					}).pipe(
						Effect.catch((cause) =>
							ownership.terminate.pipe(
								Effect.tap(() =>
									Effect.sync(() =>
										options.terminals.delete(serviceKey(address)),
									),
								),
								Effect.andThen(Effect.fail(cause)),
							),
						),
					);
				}
				return yield* options.registry.get(run.runId);
			}).pipe(
				Effect.catch((cause) =>
					rollback.pipe(Effect.andThen(Effect.fail(cause))),
				),
			);
		}).pipe(Effect.uninterruptible);
	return { startRun };
};
