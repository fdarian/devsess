import type { Socket } from 'node:net';
import { Effect } from 'effect';
import type { FileSystem } from 'effect/FileSystem';
import type { Path } from 'effect/Path';
import type { IPty } from 'node-pty';
import { type ServiceExit, UNKNOWN_EXIT_CODE } from './exit-status';
import type { LogAddress } from './logs';
import type { LiveProcessOwnership, ProcessesService } from './processes';
import {
	isActive,
	type RegistryService,
	type RunRecord,
	refreshService,
	type ServiceRecord,
	type ServiceState,
} from './registry';
import { TERMINATION_TERM_SIGNAL } from './termination';

export type LiveService = {
	readonly terminal: IPty;
	readonly address: LogAddress;
	readonly ownership: LiveProcessOwnership;
	exit: ServiceExit | undefined;
	lease:
		| { readonly id: string; readonly socket: Socket | undefined }
		| undefined;
};

export const serviceKey = (address: LogAddress) =>
	`${address.runId}:${address.serviceName}`;

export const aggregateState = (
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

export const orphanRemedy = (
	run: RunRecord,
	service: ServiceRecord,
	processGroupId: number,
) =>
	`Service ${service.name} in run ${run.runId} (${run.projectName}/${run.presetName}) has an unverified process group ${processGroupId}. Run \`kill -TERM -${processGroupId}\` manually, or run \`devsess stop --force\` to terminate it and unblock the preset.`;

export const stoppedExit = (
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

export const completedExit = (
	service: ServiceRecord,
): ServiceExit | undefined => {
	if (service.state !== 'exited' && service.state !== 'failed')
		return undefined;
	if (service.exitCode !== undefined)
		return { exitCode: service.exitCode, signal: service.signal };
	return { exitCode: UNKNOWN_EXIT_CODE };
};

export type ServiceStateApi = {
	readonly replaceService: (
		address: LogAddress,
		state: ServiceState,
		exit?: ServiceExit,
	) => Effect.Effect<RunRecord, unknown, FileSystem | Path>;
	readonly refreshServiceRecord: (
		service: ServiceRecord,
		verifyOwnership: boolean,
	) => Effect.Effect<ServiceRecord, unknown, FileSystem | Path>;
	readonly reconcile: Effect.Effect<void, unknown, FileSystem | Path>;
};

export const makeServiceState = (options: {
	readonly registry: RegistryService;
	readonly processes: ProcessesService;
}): ServiceStateApi => {
	const replaceService = (
		address: LogAddress,
		state: ServiceState,
		exit?: ServiceExit,
	) => {
		const completionStatus =
			state === 'exited' || state === 'failed'
				? ('unknown' as const)
				: undefined;
		return options.registry.get(address.runId).pipe(
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
				return options.registry.replace({
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
			return options.processes
				.groupAlive(process.processGroupId)
				.pipe(
					Effect.map((alive) =>
						refreshService(service, alive ? 'alive' : 'dead'),
					),
				);
		return options.processes
			.owns(process)
			.pipe(
				Effect.flatMap((owned) =>
					owned
						? Effect.succeed(refreshService(service, 'owned'))
						: options.processes
								.groupAlive(process.processGroupId)
								.pipe(
									Effect.map((alive) =>
										refreshService(service, alive ? 'alive' : 'dead'),
									),
								),
				),
			);
	};
	const reconcile = options.registry.list.pipe(
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
						options.registry.replace({
							...run,
							services,
							state: aggregateState(services),
						}),
					),
				);
			}),
		),
	);
	return {
		replaceService,
		refreshServiceRecord,
		reconcile,
	};
};
