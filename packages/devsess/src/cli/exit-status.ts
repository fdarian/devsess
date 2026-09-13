import { Data, Runtime } from 'effect';

export type ServiceExit = {
	readonly exitCode: number;
	readonly signal?: number;
};

/** Persisted records without an observed status use a non-success exit code. */
export const UNKNOWN_EXIT_CODE = 1;

export const serviceExitCode = (exit: ServiceExit) =>
	exit.signal !== undefined && exit.signal > 0
		? 128 + exit.signal
		: exit.exitCode;

export class ServiceExitError extends Data.TaggedError(
	'devsess/cli/ServiceExitError',
)<{
	readonly exitCode: number;
}> {
	override readonly [Runtime.errorExitCode] = this.exitCode;
	override readonly [Runtime.errorReported] = false;
}

export const serviceExit = (exit: ServiceExit) => {
	const exitCode = serviceExitCode(exit);
	return exitCode === 0 ? undefined : new ServiceExitError({ exitCode });
};
