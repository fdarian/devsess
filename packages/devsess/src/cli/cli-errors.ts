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

/** The errno code is spelled out even when the underlying message omits it, since the code is what tells launchd relaunch failures apart. */
const describeUnderlying = (cause: unknown) => {
	if (cause === undefined) return '';
	if (!(cause instanceof Error)) return `: ${String(cause)}`;
	const code =
		'code' in cause && typeof cause.code === 'string' ? cause.code : '';
	return code.length === 0 || cause.message.includes(code)
		? `: ${cause.message}`
		: `: ${code} ${cause.message}`;
};

const writeCause = (
	cause: Cause.Cause<unknown>,
	style: { readonly prefix: string; readonly includeUnderlying: boolean },
) =>
	Effect.sync(() => {
		if (Cause.hasInterruptsOnly(cause)) return;
		if (Result.isSuccess(Cause.findDie(cause))) {
			process.stderr.write(`${style.prefix}${Cause.pretty(cause)}\n`);
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
				const underlying =
					style.includeUnderlying && 'cause' in failure
						? describeUnderlying(failure.cause)
						: '';
				process.stderr.write(
					`${style.prefix}error: ${failure.message.length > 0 ? failure.message : String(failure)}${underlying}\n`,
				);
				return;
			}
		}
		process.stderr.write(`${style.prefix}${Cause.pretty(cause)}\n`);
	});

export const reportCliCause = (cause: Cause.Cause<unknown>) =>
	writeCause(cause, { prefix: '', includeUnderlying: false });

/** The daemon's stderr lands in a launchd log with no other context, so each failure carries its time and underlying errno. */
export const reportDaemonCause = (cause: Cause.Cause<unknown>) =>
	Effect.suspend(() =>
		writeCause(cause, {
			prefix: `[${new Date().toISOString()}] `,
			includeUnderlying: true,
		}),
	);
