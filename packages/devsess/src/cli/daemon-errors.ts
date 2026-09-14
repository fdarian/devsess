import { Schema } from 'effect';

export class DaemonError extends Schema.TaggedErrorClass<DaemonError>()(
	'DaemonError',
	{
		message: Schema.String,
		cause: Schema.optional(Schema.Defect()),
	},
) {}

export const errorMessage = (cause: unknown) =>
	cause instanceof Error ? cause.message : String(cause);
