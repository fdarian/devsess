import { Schema } from 'effect';

export class DaemonError extends Schema.TaggedError<DaemonError>()(
	'DaemonError',
	{
		message: Schema.String,
		cause: Schema.optional(Schema.Defect()),
	},
) {}

/** Another daemon answers on the socket. Not a failure: the process that hit it has nothing to do and must exit 0, or launchd relaunches it forever. */
export class DaemonAlreadyRunning extends Schema.TaggedError<DaemonAlreadyRunning>()(
	'DaemonAlreadyRunning',
	{ message: Schema.String, socketPath: Schema.String },
) {}

export const errorMessage = (cause: unknown) =>
	cause instanceof Error ? cause.message : String(cause);
