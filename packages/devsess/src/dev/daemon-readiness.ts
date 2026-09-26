import { createConnection } from 'node:net';
import { StringDecoder } from 'node:string_decoder';
import { Effect, Exit, Schema } from 'effect';

// The daemon serves requests one at a time, so a readiness report can queue
// behind slow ones (e.g. `devsess start` polling the run list while it waits).
const RESPONSE_TIMEOUT_MS = 5_000;
const MAX_RESPONSE_BYTES = 1024 * 1024;

const DaemonResponse = Schema.fromJsonString(
	Schema.Struct({
		version: Schema.Literal(1),
		requestId: Schema.NonEmptyString,
		ok: Schema.Boolean,
		result: Schema.optional(Schema.Unknown),
		error: Schema.optional(Schema.String),
	}),
);

type ServiceIdentity = {
	readonly socketPath: string;
	readonly runId: string;
	readonly service: string;
};

const sendReadiness = (
	identity: ServiceIdentity,
	request: {
		readonly version: 1;
		readonly requestId: string;
		readonly method: 'publish' | 'unpublish';
		readonly params: {
			readonly runId: string;
			readonly service: string;
			readonly value?: Schema.Json;
		};
	},
) =>
	Effect.tryPromise({
		try: () =>
			new Promise<string>((resolve, reject) => {
				const socket = createConnection(identity.socketPath);
				const decoder = new StringDecoder('utf8');
				let input = '';
				let settled = false;
				const finish = (complete: () => void) => {
					if (settled) return;
					settled = true;
					clearTimeout(timer);
					socket.destroy();
					complete();
				};
				const timer = setTimeout(
					() =>
						finish(() =>
							reject(new Error('Daemon readiness request timed out')),
						),
					RESPONSE_TIMEOUT_MS,
				);
				socket.once('connect', () =>
					socket.write(`${JSON.stringify(request)}\n`),
				);
				socket.on('data', (chunk) => {
					input += decoder.write(chunk);
					if (Buffer.byteLength(input) > MAX_RESPONSE_BYTES) {
						finish(() =>
							reject(new Error('Daemon readiness response is too large')),
						);
						return;
					}
					const boundary = input.indexOf('\n');
					if (boundary !== -1) finish(() => resolve(input.slice(0, boundary)));
				});
				socket.once('error', (cause) => finish(() => reject(cause)));
				socket.once('close', () =>
					finish(() =>
						reject(new Error('Daemon closed before acknowledging readiness')),
					),
				);
			}),
		catch: (cause) =>
			new Error('Could not report readiness to daemon', { cause }),
	}).pipe(
		Effect.flatMap(Schema.decodeUnknownEffect(DaemonResponse)),
		Effect.flatMap((response) =>
			response.requestId === request.requestId && response.ok
				? Effect.void
				: Effect.fail(new Error('Daemon did not acknowledge readiness')),
		),
	);

export const publishDaemonReadiness = (value: unknown) =>
	Effect.suspend(() => {
		const socketPath = process.env.DEVSESS_SOCKET;
		const runId = process.env.DEVSESS_RUN_ID;
		const service = process.env.DEVSESS_SERVICE;
		if (
			socketPath === undefined ||
			runId === undefined ||
			service === undefined
		)
			return Effect.void;
		const identity = { socketPath, runId, service };
		return Effect.acquireRelease(
			Schema.decodeUnknownEffect(Schema.Json)(value).pipe(
				Effect.flatMap((json) =>
					sendReadiness(identity, {
						version: 1,
						requestId: crypto.randomUUID(),
						method: 'publish',
						params: { runId, service, value: json },
					}),
				),
				Effect.exit,
			),
			(result) =>
				Exit.isSuccess(result)
					? sendReadiness(identity, {
							version: 1,
							requestId: crypto.randomUUID(),
							method: 'unpublish',
							params: { runId, service },
						}).pipe(Effect.catch(() => Effect.void))
					: Effect.void,
		).pipe(Effect.asVoid);
	});
