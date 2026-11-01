import { createConnection } from 'node:net';
import { Config, ConfigProvider, Effect, Option, Schema } from 'effect';
import { readSocketLine } from '../socket-line';

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
	readonly instanceId?: string;
};

export const readDaemonIdentity = Effect.gen(function* () {
	const provider = ConfigProvider.fromEnv();
	const read = (key: string) =>
		Config.String(key)
			.pipe(Config.option)
			.parse(provider)
			.pipe(Effect.map(Option.getOrUndefined));
	const socketPath = yield* read('DEVSESS_SOCKET');
	const runId = yield* read('DEVSESS_RUN_ID');
	const service = yield* read('DEVSESS_SERVICE');
	const instanceId = yield* read('DEVSESS_INSTANCE_ID');
	if (socketPath === undefined || runId === undefined || service === undefined)
		return undefined;
	return {
		socketPath,
		runId,
		service,
		...(instanceId === undefined ? {} : { instanceId }),
	};
});

export const sendDaemonRequest = (
	identity: ServiceIdentity,
	request: {
		readonly version: 1;
		readonly requestId: string;
		readonly method: string;
		readonly params: Readonly<Record<string, unknown>>;
	},
	timeoutMs = RESPONSE_TIMEOUT_MS,
) =>
	Effect.tryPromise({
		try: () =>
			new Promise<string>((resolve, reject) => {
				const socket = createConnection(identity.socketPath);
				let settled = false;
				const finish = (complete: () => void) => {
					if (settled) return;
					settled = true;
					clearTimeout(timer);
					socket.destroy();
					complete();
				};
				const timer = setTimeout(
					() => finish(() => reject(new Error('Daemon request timed out'))),
					timeoutMs,
				);
				socket.once('connect', () =>
					socket.write(`${JSON.stringify(request)}\n`),
				);
				readSocketLine(socket, MAX_RESPONSE_BYTES).then(
					(line) => finish(() => resolve(line)),
					(cause) => finish(() => reject(cause)),
				);
			}),
		catch: (cause) => new Error('Could not send request to daemon', { cause }),
	}).pipe(
		Effect.flatMap(Schema.decodeUnknownEffect(DaemonResponse)),
		Effect.flatMap((response) =>
			response.requestId === request.requestId && response.ok
				? Effect.void
				: Effect.fail(new Error('Daemon did not acknowledge request')),
		),
	);
