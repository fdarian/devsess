import { Effect, Schema } from 'effect';

export const PROTOCOL_VERSION = 1;
const Identifier = Schema.NonEmptyString;
export const ServiceSnapshot = Schema.Struct({ name: Identifier, command: Schema.NonEmptyString, cwd: Schema.NonEmptyString });
export const StartRunRequest = Schema.Struct({ version: Schema.Literal(PROTOCOL_VERSION), requestId: Identifier, method: Schema.Literal('startRun'), params: Schema.Struct({ runId: Identifier, projectName: Identifier, presetName: Identifier, invocationCwd: Schema.NonEmptyString, configSnapshot: Schema.Unknown, environment: Schema.Record(Schema.String, Schema.String), services: Schema.Array(ServiceSnapshot) }) });
export const ListRunsRequest = Schema.Struct({ version: Schema.Literal(PROTOCOL_VERSION), requestId: Identifier, method: Schema.Literal('listRuns'), params: Schema.Struct({}) });
export const StopRunRequest = Schema.Struct({ version: Schema.Literal(PROTOCOL_VERSION), requestId: Identifier, method: Schema.Literal('stopRun'), params: Schema.Struct({ runId: Identifier }) });
export const TailRequest = Schema.Struct({ version: Schema.Literal(PROTOCOL_VERSION), requestId: Identifier, method: Schema.Literal('tail'), params: Schema.Struct({ runId: Identifier, serviceName: Identifier, after: Schema.optional(Schema.Int) }) });
export const AttachRequest = Schema.Struct({ version: Schema.Literal(PROTOCOL_VERSION), requestId: Identifier, method: Schema.Literal('attach'), params: Schema.Struct({ runId: Identifier, serviceName: Identifier }) });
export const InputRequest = Schema.Struct({ version: Schema.Literal(PROTOCOL_VERSION), requestId: Identifier, method: Schema.Literal('input'), params: Schema.Struct({ runId: Identifier, serviceName: Identifier, leaseId: Identifier, data: Schema.String }) });
export const ResizeRequest = Schema.Struct({ version: Schema.Literal(PROTOCOL_VERSION), requestId: Identifier, method: Schema.Literal('resize'), params: Schema.Struct({ runId: Identifier, serviceName: Identifier, leaseId: Identifier, cols: Schema.Int, rows: Schema.Int }) });
export const DaemonRequest = Schema.Union([StartRunRequest, ListRunsRequest, StopRunRequest, TailRequest, AttachRequest, InputRequest, ResizeRequest]);

export type DaemonRequest = typeof DaemonRequest.Type;

export const DaemonResponse = Schema.Struct({ version: Schema.Literal(PROTOCOL_VERSION), requestId: Identifier, ok: Schema.Boolean, result: Schema.optional(Schema.Unknown), error: Schema.optional(Schema.String) });

export type DaemonResponse = typeof DaemonResponse.Type;

export const DaemonEvent = Schema.Struct({ version: Schema.Literal(PROTOCOL_VERSION), requestId: Identifier, event: Schema.Literal('output'), data: Schema.String, offset: Schema.Int });
export type DaemonEvent = typeof DaemonEvent.Type;
export const decodeRequest = Schema.decodeUnknownEffect(Schema.fromJsonString(DaemonRequest));
export const decodeResponse = Schema.decodeUnknownEffect(Schema.fromJsonString(DaemonResponse));
export const encodeFrame = (frame: DaemonResponse | DaemonEvent) => Effect.succeed(JSON.stringify(frame));
