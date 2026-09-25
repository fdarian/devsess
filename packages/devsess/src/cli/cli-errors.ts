import { Cause, Effect, Option, Result } from 'effect';
import { ServiceExitError } from './exit-status';

const expectedErrors = new Set([
	'devsess/cli/CommandError',
	'DaemonClientError',
	'DaemonBootstrapError',
	'DaemonStatusError',
	'ProjectPathResolutionError',
	'TerminalTransportError',
	'PlatformError',
	'ConfigError',
	'SchemaError',
	'ProcessError',
	'PtyError',
	'DaemonError',
	'devsess/cli/RunNotFound',
	'devsess/cli/RunAlreadyReserved',
]);

export const reportCliCause = (cause: Cause.Cause<unknown>) =>
	Effect.sync(() => {
		if (Cause.hasInterruptsOnly(cause)) return;
		if (Result.isSuccess(Cause.findDie(cause))) {
			process.stderr.write(`${Cause.pretty(cause)}\n`);
			return;
		}
		const failure = Option.getOrUndefined(Cause.findErrorOption(cause));
		if (failure instanceof ServiceExitError) return;
		if (failure !== null && typeof failure === 'object' && '_tag' in failure) {
			if (failure._tag === 'ShowHelp') return;
			if (
				typeof failure._tag === 'string' &&
				expectedErrors.has(failure._tag) &&
				'message' in failure &&
				typeof failure.message === 'string'
			) {
				process.stderr.write(
					`error: ${failure.message.length > 0 ? failure.message : String(failure)}\n`,
				);
				return;
			}
		}
		process.stderr.write(`${Cause.pretty(cause)}\n`);
	});
