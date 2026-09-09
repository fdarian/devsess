import { Context, Effect, Layer, Schema, Semaphore } from 'effect';
import { FileSystem } from 'effect/FileSystem';
import { Path } from 'effect/Path';
import type { PlatformError } from 'effect/PlatformError';

export const LogAddressSchema = Schema.Struct({
	runId: Schema.NonEmptyString,
	serviceName: Schema.NonEmptyString,
});
export type LogAddress = typeof LogAddressSchema.Type;

const NonNegativeInt = Schema.Int.check(
	Schema.makeFilter((value) => value >= 0),
);

export const LogEventSchema = Schema.Struct({
	data: Schema.String,
	offset: NonNegativeInt,
});
export type LogEvent = typeof LogEventSchema.Type;

const StoredLogSchema = Schema.fromJsonString(
	Schema.Struct({
		nextOffset: NonNegativeInt,
		events: Schema.Array(LogEventSchema),
	}),
);

const logKey = (address: LogAddress) =>
	`${address.runId}:${address.serviceName}`;

const retain = (events: Array<LogEvent>, maxBytes: number) => {
	const encoder = new TextEncoder();
	const kept = [...events];
	while (
		kept.length > 1 &&
		kept.reduce(
			(total, event) => total + encoder.encode(event.data).byteLength,
			0,
		) > maxBytes
	) {
		kept.shift();
	}
	return kept;
};

const writeAtomically = (target: string, content: string) =>
	Effect.gen(function* () {
		const fileSystem = yield* FileSystem;
		const path = yield* Path;
		const temporary = `${target}.${crypto.randomUUID()}.tmp`;
		yield* fileSystem.makeDirectory(path.dirname(target), { recursive: true });
		yield* fileSystem.writeFileString(temporary, content, { mode: 0o600 });
		yield* fileSystem.rename(temporary, target);
	});

export class Logs extends Context.Service<
	Logs,
	{
		readonly append: (
			address: LogAddress,
			data: string,
		) => Effect.Effect<
			LogEvent,
			PlatformError | Schema.SchemaError,
			FileSystem | Path
		>;
		readonly replayAndSubscribe: (
			address: LogAddress,
			after: number,
			listener: (event: LogEvent) => Effect.Effect<void>,
		) => Effect.Effect<
			{
				readonly replay: ReadonlyArray<LogEvent>;
				readonly unsubscribe: Effect.Effect<void>;
			},
			PlatformError | Schema.SchemaError,
			FileSystem | Path
		>;
	}
>()('devsess/cli/Logs') {
	static readonly layer = (options: {
		dataDirectory: string;
		maxBytes: number;
	}) => Layer.effect(Logs, makeLogs(options));
}

const makeLogs = (options: { dataDirectory: string; maxBytes: number }) =>
	Effect.gen(function* () {
		const fileSystem = yield* FileSystem;
		const path = yield* Path;
		const semaphore = yield* Semaphore.make(1);
		const listeners = new Map<
			string,
			Set<(event: LogEvent) => Effect.Effect<void>>
		>();
		const logPath = (address: LogAddress) =>
			path.join(
				options.dataDirectory,
				'logs',
				address.runId,
				`${address.serviceName}.json`,
			);
		const read = (address: LogAddress) => {
			const target = logPath(address);
			return fileSystem.exists(target).pipe(
				Effect.flatMap((exists) =>
					exists
						? fileSystem
								.readFileString(target)
								.pipe(
									Effect.flatMap(Schema.decodeUnknownEffect(StoredLogSchema)),
								)
						: Effect.succeed({
								nextOffset: 0,
								events: [] as Array<LogEvent>,
							}),
				),
			);
		};
		const append = (address: LogAddress, data: string) =>
			semaphore.withPermit(
				read(address).pipe(
					Effect.flatMap((stored) => {
						const event = {
							data,
							offset:
								stored.nextOffset + new TextEncoder().encode(data).byteLength,
						};
						const next = {
							nextOffset: event.offset,
							events: retain([...stored.events, event], options.maxBytes),
						};
						const active = listeners.get(logKey(address));
						return writeAtomically(logPath(address), JSON.stringify(next)).pipe(
							Effect.andThen(
								active === undefined
									? Effect.void
									: Effect.forEach(active, (listener) => listener(event)),
							),
							Effect.as(event),
						);
					}),
				),
			);
		const replayAndSubscribe = (
			address: LogAddress,
			after: number,
			listener: (event: LogEvent) => Effect.Effect<void>,
		) =>
			semaphore.withPermit(
				read(address).pipe(
					Effect.map((stored) => {
						const key = logKey(address);
						const current = listeners.get(key);
						const subscribed =
							current === undefined
								? new Set<(event: LogEvent) => Effect.Effect<void>>()
								: current;
						subscribed.add(listener);
						listeners.set(key, subscribed);
						const unsubscribe = semaphore.withPermit(
							Effect.sync(() => {
								subscribed.delete(listener);
								if (subscribed.size === 0) listeners.delete(key);
							}),
						);
						return {
							replay: stored.events.filter((event) => event.offset > after),
							unsubscribe,
						};
					}),
				),
			);
		return Logs.of({ append, replayAndSubscribe });
	});
