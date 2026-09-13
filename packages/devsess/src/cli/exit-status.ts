import { Data, Runtime } from 'effect';

export type ServiceExit = {
	readonly exitCode: number;
	readonly signal?: number;
};

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
