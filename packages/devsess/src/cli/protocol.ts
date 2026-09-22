import { Effect, Schema } from 'effect';
import { Identifier } from './identifiers';

export const PROTOCOL_VERSION = 1;
export const LIVE_OUTPUT_OVERFLOW_MESSAGE =
	'This client fell too far behind live output; re-run devsess tail to replay from the retained log.';
export { Identifier } from './identifiers';
export const ServiceSnapshot = Schema.Struct({
	name: Identifier,
	command: Schema.NonEmptyString,
	cwd: Schema.NonEmptyString,
});
export const StartRunRequest = Schema.Struct({
	version: Schema.Literal(PROTOCOL_VERSION),
	requestId: Identifier,
	method: Schema.Literal('startRun'),
	params: Schema.Struct({
		runId: Identifier,
		projectName: Identifier,
		presetName: Identifier,
		canonicalCwd: Schema.NonEmptyString,
		invocationCwd: Schema.NonEmptyString,
		configSnapshot: Schema.Json,
		environment: Schema.Record(Schema.String, Schema.String),
		services: Schema.Array(ServiceSnapshot),
	}),
});
export const ListRunsRequest = Schema.Struct({
	version: Schema.Literal(PROTOCOL_VERSION),
	requestId: Identifier,
	method: Schema.Literal('listRuns'),
	params: Schema.Struct({}),
});
export const InfoRequest = Schema.Struct({
	version: Schema.Literal(PROTOCOL_VERSION),
	requestId: Identifier,
	method: Schema.Literal('info'),
	params: Schema.Struct({}),
});
export const ShutdownRequest = Schema.Struct({
	version: Schema.Literal(PROTOCOL_VERSION),
	requestId: Identifier,
	method: Schema.Literal('shutdown'),
	params: Schema.Struct({ force: Schema.optional(Schema.Boolean) }),
});
export const StopRunRequest = Schema.Struct({
	version: Schema.Literal(PROTOCOL_VERSION),
	requestId: Identifier,
	method: Schema.Literal('stopRun'),
	params: Schema.Struct({
		runId: Identifier,
		force: Schema.optional(Schema.Boolean),
	}),
});
export const TailRequest = Schema.Struct({
	version: Schema.Literal(PROTOCOL_VERSION),
	requestId: Identifier,
	method: Schema.Literal('tail'),
	params: Schema.Struct({
		runId: Identifier,
		serviceName: Identifier,
		after: Schema.optional(Schema.Int),
	}),
});
export const AttachRequest = Schema.Struct({
	version: Schema.Literal(PROTOCOL_VERSION),
	requestId: Identifier,
	method: Schema.Literal('attach'),
	params: Schema.Struct({ runId: Identifier, serviceName: Identifier }),
});
export const InputRequest = Schema.Struct({
	version: Schema.Literal(PROTOCOL_VERSION),
	requestId: Identifier,
	method: Schema.Literal('input'),
	params: Schema.Struct({
		runId: Identifier,
		serviceName: Identifier,
		leaseId: Identifier,
		data: Schema.String,
	}),
});
export const ResizeRequest = Schema.Struct({
	version: Schema.Literal(PROTOCOL_VERSION),
	requestId: Identifier,
	method: Schema.Literal('resize'),
	params: Schema.Struct({
		runId: Identifier,
		serviceName: Identifier,
		leaseId: Identifier,
		cols: Schema.Int,
		rows: Schema.Int,
	}),
});
export const DetachRequest = Schema.Struct({
	version: Schema.Literal(PROTOCOL_VERSION),
	requestId: Identifier,
	method: Schema.Literal('detach'),
	params: Schema.Struct({
		runId: Identifier,
		serviceName: Identifier,
		leaseId: Identifier,
	}),
});
export const DaemonRequest = Schema.Union([
	StartRunRequest,
	ListRunsRequest,
	InfoRequest,
	ShutdownRequest,
	StopRunRequest,
	TailRequest,
	AttachRequest,
	InputRequest,
	ResizeRequest,
	DetachRequest,
]);

export type DaemonRequest = typeof DaemonRequest.Type;

export const DaemonInfo = Schema.Struct({
	pid: Schema.Int,
	startedAt: Schema.NonEmptyString,
	executable: Schema.NonEmptyString,
	scriptPath: Schema.NonEmptyString,
	packageVersion: Schema.NonEmptyString,
	protocolVersion: Schema.Literal(PROTOCOL_VERSION),
	socketPath: Schema.NonEmptyString,
	dataDirectory: Schema.NonEmptyString,
	runCount: Schema.Int,
	liveServiceCount: Schema.Int,
	attachedClientCount: Schema.Int,
});

export type DaemonInfo = typeof DaemonInfo.Type;

export const DaemonResponse = Schema.Struct({
	version: Schema.Literal(PROTOCOL_VERSION),
	requestId: Identifier,
	ok: Schema.Boolean,
	result: Schema.optional(Schema.Unknown),
	error: Schema.optional(Schema.String),
});

export type DaemonResponse = typeof DaemonResponse.Type;

export const DaemonOutputEvent = Schema.Struct({
	version: Schema.Literal(PROTOCOL_VERSION),
	requestId: Identifier,
	event: Schema.Literal('output'),
	data: Schema.String,
	offset: Schema.Int,
});
export const DaemonExitEvent = Schema.Struct({
	version: Schema.Literal(PROTOCOL_VERSION),
	requestId: Identifier,
	event: Schema.Literal('exit'),
	exitCode: Schema.Int,
	signal: Schema.optional(Schema.Int),
});
export const DaemonEvent = Schema.Union([DaemonOutputEvent, DaemonExitEvent]);
export type DaemonEvent = typeof DaemonEvent.Type;
export const decodeRequest = Schema.decodeUnknownEffect(
	Schema.fromJsonString(DaemonRequest),
);
export const decodeRequestId = Schema.decodeUnknownEffect(
	Schema.fromJsonString(Schema.Struct({ requestId: Identifier })),
);
export const decodeResponse = Schema.decodeUnknownEffect(
	Schema.fromJsonString(DaemonResponse),
);
export const encodeFrame = (frame: DaemonResponse | DaemonEvent) =>
	Effect.succeed(JSON.stringify(frame));

export const MAX_FRAME_BYTES = 1024 * 1024;

export const splitFrames = (buffer: string, chunk: string) => {
	const next = `${buffer}${chunk}`;
	if (Buffer.byteLength(next) > MAX_FRAME_BYTES) {
		return { _tag: 'TooLarge' as const };
	}
	const frames = next.split('\n');
	const remainder = frames.pop();
	if (remainder === undefined) {
		return { _tag: 'TooLarge' as const };
	}
	return {
		_tag: 'Frames' as const,
		frames: frames.filter((frame) => frame.length > 0),
		remainder,
	};
};
